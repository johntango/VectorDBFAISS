# VectorDBFAISS

John R Williams jrw@mit.edu MIT author
This code uses OpenAI API to embed documents and store both locally eg on your own machine or on your own Cloud based machine. This provides a means of keeping your GAN private and not hosting it on say OpenAI, Azure or AWS.
This code is most easily run in CodeSpaces directly from your GitHub Repo. You will need to provide an OpenAI API Key in your Repo in Settings->Codespaces secrets->OPENAI_API_KEY or alter the code so the key is available.  You could alter the code to use your own embeddings. 
The hyper-parameters involved in chunking are chunk size and size of overlap of chunks, can be easily set. 

The GAN is automatically created in the UI by loading all documents from the directory "documents". Single documents can be added and the system checks if the document is already stored so duplicates are not formed. Similarly reloading all documents are checked for duplicates. Documents and their embeddings are permanently stored in MySQL but an in-memory data structure called FAISS is used for retrieval. FAISS is initialized from MySQL on startup. If MySQL is not available it is created on startup. 

Whan a Question is asked the GAN can be used to retrieve say k=5 closest documents to the question and place them in the Prompt so the LLM can answer from specific data. 


Repository secrets
There are 2 approaches here the first (server.js and embed.js) uses the full embedding vectors
The second (serverArray.js and embedArray.js uses only the first 5 elemends of the embedding vector for selecting documents)
The FAISS structure stores the docId and the embedding vector
SQLite stores the full context eg docId, embedding vector, and text document
Note that k = number of documents to be retrieved is set in function below
async function searchDocuments() {
const query = document.getElementById('search-query').value;
const res = await fetch('/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ query, k: 2 })
