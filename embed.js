
import { OpenAI } from "openai";

const openai = new OpenAI(process.env.OPENAI_API_KEY);

/**
     * Takes a set of tokens as input.
     * Returns an array of embeddings.
     * @param {string[]} tokens - The set of tokens.
     * @returns {number[][]} The array of embeddings.
     */
async function getEmbeddings(tokens) {
    console.log("start getEmbeddings");

    let response;
    try {
        console.log("initiating openai api call");
        response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: tokens,
            embedding_format: "float"
        });
    } catch (e) {
        console.error("Error calling OpenAI API getEmbeddings:", e?.response?.data[0]);
        throw new Error("Error calling OpenAI API getEmbeddings");
    }

    return response.data.embedding;
}
exports.getEmbeddings = getEmbeddings;