# VectorDBFAISS

John R Williams author
There are 2 approaches here the first (server.js and embed.js) uses the full embedding vectors
The second (serverArray.js and embedArray.js uses only the first 5 elemends of the embedding vector for selecting documents)
The FAISS structure stores the docId and the embedding vector
SQLite stores the full context eg docId, embedding vector, and text document
