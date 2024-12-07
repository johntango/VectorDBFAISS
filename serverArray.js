import express from 'express';
import sqlite3 from 'sqlite3'; // SQLite for storing metadata and documents
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { create, all } from 'mathjs';
import {  getEmbeddings, getAnswer } from './embedArray.js';

const math = create(all);

// Define `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ALENGTH = 5;

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

// FAISS mock implementation with math.js for cosine similarity
const FAISS = {
    index: [],

    add: (vec, docId) => {
        let vector = vec.slice(0,ALENGTH)
        FAISS.index.push({ vector, docId });
        console.log(`Added document with ID ${docId} to FAISS index.`);
    },

    search: (queryVector, k) => {
        const cosineSimilarity = (vecA, vecB) => {
            const dotProduct = math.dot(vecA, vecB);
            const magnitudeA = math.norm(vecA, 2); // Euclidean norm
            const magnitudeB = math.norm(vecB, 2); // Euclidean norm
            return dotProduct / (magnitudeA * magnitudeB);
        };

        if (FAISS.index.length === 0) return [];
        const results = FAISS.index.map((item) => ({
            docId: item.docId,
            score: cosineSimilarity(item.vector, queryVector),
        }));
        let res = results.sort((a, b) => b.score - a.score).slice(0, k);
        console.log(`Context Documents: ${JSON.stringify(res)}`);
        return res;
    },
};

// Synchronize FAISS with the SQLite database
const synchronizeFAISS = () => {
    db.get(`SELECT COUNT(*) as count FROM documents`, (err, row) => {
        if (err) {
            console.error('Error checking for existing documents:', err);
            return;
        }

        if (row.count === 0) {
            console.log('No documents found in SQLite database.');
            return;
        }

        db.all(`SELECT id, vector FROM documents`, [], (err, rows) => {
            if (err) {
                console.error('Error synchronizing FAISS with SQLite:', err);
                return;
            }

            rows.forEach((row) => {
                const vector = new Float32Array(row.vector.buffer); // Convert blob back to vector
                FAISS.add(Array.from(vector.slice(0,ALENGTH)), row.id); // Add to FAISS index
            });

            console.log(`Synchronized FAISS with ${rows.length} documents from SQLite.`);
        });
    });
};

app.post('/add', async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    try {
        const vector = await getEmbeddings(content); // Assume this returns a numerical array
        const vectorBuffer = Buffer.from(new Float32Array(vector).buffer); // Convert to binary data

        db.run(
            `INSERT OR IGNORE INTO documents (content, vector) VALUES (?, ?)`,
            [content, vectorBuffer],
            function (err) {
                if (err) return res.status(500).json({ error: 'Error adding document.' });

                if (this.changes > 0) {
                    FAISS.add(vector, this.lastID); // Add to FAISS index
                    res.json({ message: 'Document added.', docId: this.lastID });
                } else {
                    res.json({ message: 'Document already exists.' });
                }
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Error processing document.' });
    }
});

app.get('/count-documents', (req, res) => {
    db.get(`SELECT COUNT(*) as count FROM documents`, (err, row) => {
        if (err) {
            console.error("Error retrieving document count:", err);
            return res.status(500).json({ error: 'Error retrieving count.' });
        }

        res.json({ count: row.count });
    });
});

app.post('/search', async (req, res) => {
    const { query, k = 1 } = req.body;

    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        const queryVector = await getEmbeddings(query); // Assume this returns a numerical array
        let qVec = queryVector.slice(0,ALENGTH)
        const faissResults = FAISS.search(qVec, k);

        const documentIds = faissResults.map((result) => result.docId);
        const placeholders = documentIds.map(() => '?').join(',');
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

        const topResults = faissResults.map((result) => {
            const document = topDocuments.find((doc) => doc.id === result.docId);
            return { ...result, content: document ? document.content : null };
        });

        const context = topResults
            .filter((result) => result.content)
            .map((result, i) => `${i + 1}. ${result.content}`)
            .join('\n');

        const answer = await getAnswer(context, query);

        res.json({ query, answer });
    } catch (err) {
        console.error("Error in /search:", err);
        res.status(500).json({ error: 'Error processing query.', details: err.message });
    }
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
    