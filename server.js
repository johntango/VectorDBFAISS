import express from 'express';
import sqlite3 from 'sqlite3'; // SQLite for storing metadata and documents
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { get } from 'http';

import {  getEmbeddings, getAnswer, processTextFile } from './embed.js';
import { add } from 'mathjs';



// Define `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Initialize SQLite database
const db = new sqlite3.Database('./vectors.db', (err) => {
    if (err) {
        console.error('Error opening SQLite database:', err);
    } else {
        console.log('SQLite database connected.');
        db.run(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT UNIQUE,
                vector BLOB
            )
        `);
    }
});

// FAISS mock implementation with cosine similarity
const FAISS = {
    index: [],

    add: (vector, docId) => {
        FAISS.index.push({ vector, docId });
        console.log(`Added document with ID ${docId} to FAISS index. vector: ${vector[0]}`);
    },

    search: (queryVector, k) => {
        const cosineSimilarity = (vecA, vecB) => {
            const dotProduct = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
            const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val ** 2, 0));
            const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val ** 2, 0));
            return dotProduct / (magnitudeA * magnitudeB);
        };
        if (FAISS.index.length === 0) return [];
        const results = FAISS.index.map((item) => ({
            docId: item.docId,
            score: cosineSimilarity(queryVector, item.vector),
        }));

        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    },
};

// sync FAISS
const synchronizeFAISS = () => {
    // check if the table exists and if it has any documents
    db.get(`SELECT COUNT(*) as count FROM documents`, (err, row) => {
        if (err) {
            console.error('Error checking for existing documents:', err);
            return;
        }
    // if no documents, return  
        if (row.count === 0) {
            console.log('No documents found in SQLite database.');
            return;
        }
    // if documents exist, retrieve them and add to FAISS index

        db.all(`SELECT id, vector FROM documents`, [], (err, rows) => {
            if (err) {
                console.error('Error synchronizing FAISS with SQLite:', err);
                return;
            }

            rows.forEach((row) => {
                const vector = Array.from(new Float32Array(row.vector.buffer)); // Convert blob back to vector
                console.log("FAISS retrieve from SQL vector", vector[0]);
                FAISS.add(vector, row.id); // Add to FAISS index
            });

            console.log(`Synchronized FAISS with ${rows.length} documents from SQLite.`);
    });
    });
};


// Mock vectorization function
//async function vectorize(text) {
//   return text.split('').map((char) => char.charCodeAt(0) % 10); // Mock vector
//}

app.post('/add', async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });
    try {
        let chunks = await processTextFile(content, 1000);
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            // get filename and strip of extension for chunk name
            let file = `chunks${i}.txt`;
            const chunkName = `${file.split('.').slice(0, -1).join('.')}_chunk_${i + 1}`;
            console.log(`Processing chunk: ${chunkName}`);
            // Write to SQLite and FAISS
            let documentResult = await addDocumentToDB(chunk, chunkName)
            if (documentResult.changes > 0) {
                res.json({ message: 'Document already exists.' });
            }
        res.json({ message: 'Document added.', docId: this.lastID });
        } 
    }
    catch (err) {
        res.status(500).json({ error: 'Error processing document.' });
    }
});

// Get document count
app.get('/count-documents', (req, res) => {
    console.log("Counting documents...");

    // Step 1: Retrieve all vectors and log them
    db.all(`SELECT id, vector FROM documents`, [], (err, rows) => {
        if (err) {
            console.error("Error retrieving documents:", err);
            return res.status(500).json({ error: 'Error retrieving documents.' });
        }

        rows.forEach((row) => {
            try {
                // Convert blob back to Float32Array
                const vector = Array.from(new Float32Array(row.vector.buffer));
                console.log(`Document ID: ${row.id}, Vector: ${JSON.stringify(vector[0])}`);
            } catch (conversionError) {
                console.error(`Error converting vector for Document ID: ${row.id}`, conversionError);
            }
        });
    });

    // Step 2: Count the total number of documents
    db.get(`SELECT COUNT(*) as count FROM documents`, (err, row) => {
        if (err) {
            console.error("Error retrieving document count:", err);
            return res.status(500).json({ error: 'Error retrieving count.' });
        }

        res.json({ count: row.count });
    });
});


// Load all documents from folder
app.get('/load-documents', async (req, res) => {
    const folderPath = path.join(__dirname, 'documents');

    try {
        const files = await fs.readdir(folderPath); // Get list of files
        const results = [];

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const content = await fs.readFile(filePath, 'utf-8'); // Read file content
            console.log('Processing content:', content);
            let chunks = await processTextFile(content, 1000);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                // get filename and strip of extension for chunk name
                const chunkName = `${file.split('.').slice(0, -1).join('.')}_chunk_${i + 1}`;
                console.log(`Processing chunk: ${chunkName}`);
    
                // Write to SQLite and FAISS
                let documentResult = await addDocumentToDB(chunk, chunkName);
                results.push(documentResult); // Add the result to the array
            }
        }
        const count = results.length;
        res.json({ message: `Loaded ${count} documents.`, results });
    } catch (err) {
        console.error('Error loading documents:', err);
        res.status(500).json({ error: 'Error loading documents.', details: err.message });
    }
});
async function addDocumentToDB(content) {
    const vector = await getEmbeddings(content);
    // Convert vector to binary for SQLite
    const vectorBuffer = Buffer.from(new Float32Array(vector).buffer);
    // Insert into SQLite and FAISS
    let documentResult = await new Promise((resolve, reject) => {
        db.run(
            `INSERT OR IGNORE INTO documents (content, vector) VALUES (?, ?)`,
            [content, vectorBuffer],
            function (err) {
                if (err) return reject(err); // Reject promise on error

                if (this.changes > 0) {
                    // Add vector to FAISS and resolve with document ID
                    FAISS.add(vector, this.lastID);
                    resolve({ message: 'Document added.', docId: this.lastID });
                } else {
                    // Document already exists
                    resolve({ message: 'Document already exists.' });
                }
            }
        );
    });
    return documentResult;
}

app.post('/search', async (req, res) => {
    const { query, k=1 } = req.body;
    
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        // Step 1: Generate query vector
        const queryVector = await getEmbeddings(query); // Assume this returns a numerical array

        // Step 2: Use FAISS to search for the top-k similar documents
        console.log("Querying FAISS with query vector...");
        const faissResults = FAISS.search(queryVector, k); // FAISS returns top-k document IDs and scores

        // Step 3: Retrieve document contents for the top-k results
        const documentIds = faissResults.map((result) => result.docId);
        const placeholders = documentIds.map(() => '?').join(','); // Prepare SQL placeholders for IN clause
        const topDocuments = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, content FROM documents WHERE id IN (${placeholders})`,
                documentIds,
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });

        // Map FAISS results to their corresponding document content
        const topResults = faissResults.map((result) => {
            const document = topDocuments.find((doc) => doc.id === result.docId);
            return { ...result, content: document ? document.content : null };
        });

        // Step 4: Build the context for GPT
        const context = topResults
            .filter((result) => result.content) // Ensure content exists
            .map((result, i) => `${i + 1}. ${result.content}`)
            .join('\n');

        // Step 5: Call OpenAI to get the answer
        const answer = await getAnswer(context, query);

        // Step 6: Return the results and the GPT answer
        res.json({ query: query, answer });
    } catch (err) {
        console.error("Error in /search:", err);
        res.status(500).json({ error: 'Error processing query.', details: err.message });
    }
});




// Fetch all documents (for debugging)
app.get('/documents', (req, res) => {
    db.all(`SELECT * FROM documents`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error fetching documents.' });
        res.json(rows);
    });
});


// Serve the default web page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>VectorDB Interface</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 2rem; }
                button { margin-top: 1rem; }
                textarea, input { width: 100%; margin-top: 0.5rem; }
                .output { margin-top: 1rem; padding: 1rem; background-color: #f4f4f4; border: 1px solid #ddd; }
            </style>
        </head>
        <body>
            <h1>VectorDB Interface</h1>
            <h2>Add Document</h2>
            <textarea id="add-content" placeholder="Enter document text here"></textarea>
            <button onclick="addDocument()">Add Document</button>
            <div class="output" id="add-output"></div>

            <h2>Search Documents</h2>
            <textarea id="search-query" placeholder="Enter search query here"></textarea>
            <button onclick="searchDocuments()">Search</button>
            <div class="output" id="search-output"></div>

            <h2>Load All Documents from Folder</h2>
            <button onclick="loadDocuments()">Load All Documents</button>
            <div class="output" id="documents-output"></div>

            <h2>Count All Documents</h2>
            <button onclick="countDocuments()">Count All Documents</button>
            <div class="output" id="documents-count"></div>
            <script>
                async function addDocument() {
                    const content = document.getElementById('add-content').value;
                    const res = await fetch('/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content })
                    });
                    const data = await res.json();
                    document.getElementById('add-output').innerText = JSON.stringify(data, null, 2);
                }

                async function searchDocuments() {
                    const query = document.getElementById('search-query').value;
                    const res = await fetch('/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query, k: 2 })
                    });
                    const data = await res.json();
                    document.getElementById('search-output').innerText = JSON.stringify(data, null, 2);
                }

                async function loadDocuments() {
                    const res = await fetch('/load-documents');
                    const data = await res.json();
                    document.getElementById('documents-output').innerHTML = JSON.stringify(data, null, 2);
                }
                    async function countDocuments() {
                    const res = await fetch('/count-documents');
                    const data = await res.json();
                    document.getElementById('documents-count').innerHTML = JSON.stringify(data, null, 2);
                }
            </script>
        </body>
        </html>
    `);
})
//Synchronize FAISS and start server
synchronizeFAISS();
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
    