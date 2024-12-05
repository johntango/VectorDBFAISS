import express from 'express';
import sqlite3 from 'sqlite3'; // SQLite for storing metadata and documents
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { get } from 'http';
import { tokenizeContent, getRelevantTokens, getEmbeddings } from './embed.js';

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
                content TEXT,
                vector BLOB
            )
        `);
    }
});

// FAISS mock implementation
const FAISS = {
    index: [],
    add: (vector, docId) => FAISS.index.push({ vector, docId }),
    search: (queryVector, k) => {
        return FAISS.index.map((item) => ({
            docId: item.docId,
            score: Math.random(),
        })).sort((a, b) => b.score - a.score).slice(0, k);
    },
};


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
            <button onclick="loadDocuments()">Get All Documents</button>
            <div class="output" id="documents-output"></div>

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
                        body: JSON.stringify({ query, k: 5 })
                    });
                    const data = await res.json();
                    document.getElementById('search-output').innerText = JSON.stringify(data, null, 2);
                }

                async function loadDocuments() {
                    const res = await fetch('/load-documents');
                    const data = await res.json();
                    document.getElementById('documents-output').innerHTML = JSON.stringify(data, null, 2);
                }
            </script>
        </body>
        </html>
    `);
});

// Add document
app.post('/add', async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    try {
        const vector = await vectorize(content);
        db.run(`INSERT INTO documents (content, vector) VALUES (?, ?)`, [content, Buffer.from(vector)], function (err) {
            if (err) return res.status(500).json({ error: 'Failed to insert document.' });

            FAISS.add(vector, this.lastID);
            res.json({ message: 'Document added.', docId: this.lastID });
        });
    } catch (err) {
        res.status(500).json({ error: 'Error processing document.' });
    }
});

// Load all documents from the "documents" folder and add them to the database
app.get('/load-documents', async (req, res) => {
    const folderPath = path.join(__dirname, 'documents');

    try {
        const files = await fs.readdir(folderPath);
        const results = [];

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            let tokens = await tokenizeContent(content);
            let relevantTokens = await getRelevantTokens(tokens);

            const vector = await getEmbeddings(relevantTokens.join(' '));
            console.log(JSON.stringify(vector))
            await new Promise((resolve, reject) => {
                db.run(`INSERT INTO documents (content, vector) VALUES (?, ?)`, [content, Buffer.from(vector)], function (err) {
                    if (err) reject(err);

                    FAISS.add(vector, this.lastID);
                    results.push({ message: 'Document added.', docId: this.lastID, file });
                    resolve();
                });
            });
        }

        res.json({ message: 'All documents loaded.', results });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load documents.', details: err.message });
    }
});

// Search documents
app.post('/search', async (req, res) => {
    const { query, k = 5 } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        const queryVector = await vectorize(query);
        const results = FAISS.search(queryVector, k);

        const ids = results.map((r) => r.docId).join(',');
        db.all(`SELECT * FROM documents WHERE id IN (${ids})`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Error fetching documents.' });
            res.json(rows);
        });
    } catch (err) {
        res.status(500).json({ error: 'Error processing query.' });
    }
});

// Fetch all documents (for debugging)
app.get('/documents', (req, res) => {
    db.all(`SELECT * FROM documents`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error fetching documents.' });
        res.json(rows);
    });
});

// Start server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
