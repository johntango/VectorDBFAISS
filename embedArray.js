import csvParser from "csv-parser";
import createCsvWriter from "csv-writer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { URL } from "url";
import { parse } from "node-html-parser";
import natural from "natural";
import { create, all } from "mathjs";

import { OpenAI } from "openai";

dotenv.config();
const math = create(all);

// Get the API key from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Tokenizes HTML content, removes irrelevant tags, and limits the token length.
 * @param {string} content - The HTML content string.
 * @returns {string[]} The array of tokenized words.
 */
async function tokenizeContent(content) {
    const cleanContent = removeHTMLElementNamesFromString(content);
    const tokenizer = new natural.WordTokenizer();
    const tokens = tokenizer.tokenize(cleanContent);
    return tokens.slice(0, 3000); // Limit token length
}

/**
 * Cleans a string by removing common HTML element names.
 * @param {string} stringContent - The string to clean.
 * @returns {string} The cleaned string.
 */
function removeHTMLElementNamesFromString(stringContent) {
    const regex =
        /\b(div|span|li|a|ul|section|script|footer|body|html|link|img|href|svg|alt|target|js|javascript|lang|head|gtag|meta|charset|utf|woff2|crossorigin|anonymous|link|rel|preload|as|font|href|assets|fonts|Inter|UI|var|woff2|type|font|css|stylesheet|text)\b/g;
    return stringContent.replace(regex, "");
}

/**
 * Uses OpenAI to identify relevant tokens from a list of tokens.
 * @param {string[]} tokens - Tokenized words.
 * @returns {string[]} Relevant tokens.
 */
async function getRelevantTokens(tokens) {
    console.log("start getRelevantTokens");
    const tokenString = Array.isArray(tokens) ? tokens.join(" ") : tokens;
    const promptStart = `Given the following tokenized text, identify the most relevant tokens:\n\n`;
    const promptEnd = `\n\nRelevant tokens:`;

    const availableTokens = 4096 - promptStart.length - promptEnd.length;
    const prompt = tokenString.length > availableTokens
        ? promptStart + tokenString.slice(0, availableTokens) + promptEnd
        : promptStart + tokenString + promptEnd;

    try {
        const response = await openai.completions.create({
            model: "gpt-3.5-turbo-instruct",
            prompt: prompt,
            max_tokens: 2000,
            temperature: 0.8,
        });
        console.log("finished getRelevantTokens");
        const relevantTokensText = response.choices[0].text.trim();
        return relevantTokensText.split(" ");
    } catch (e) {
        console.error("Error calling OpenAI API:", e?.response?.data?.error);
        throw new Error("Error calling OpenAI API for getRelevantTokens");
    }
}

/**
 * Saves relevant tokens to a CSV file.
 * @param {object[]} tokenizedContents - Array of tokenized content objects with URLs.
 * @param {string} outputPath - Output CSV file path.
 */
async function saveRelevantTokensToCsv(tokenizedContents, outputPath) {
    console.log("start saveRelevantTokensToCsv");
    const csvWriter = createCsvWriter.createObjectCsvWriter({
        path: outputPath,
        header: [
            { id: "url", title: "URL" },
            { id: "relevantTokens", title: "Relevant Tokens" },
        ],
    });
    const records = [];
    for (const content of tokenizedContents) {
        const relevantTokens = await getRelevantTokens(content.tokens);
        records.push({
            url: content.url,
            relevantTokens: relevantTokens.join(" "),
        });
    }
    await csvWriter.writeRecords(records);
    console.log(`Relevant tokens saved to ${outputPath}`);
}

/**
 * Retrieves embeddings for a list of tokens using OpenAI API.
 * @param {string[]} tokens - Array of tokens.
 * @returns {number[]} Embedding array.
 */
async function getEmbeddings(tokens) {
    console.log("start getEmbeddings");
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: tokens,
            embedding_format: "float",
        });
        return response.data[0].embedding;
    } catch (e) {
        console.error("Error calling OpenAI API for embeddings:", e?.response?.data?.error);
        throw new Error("Error retrieving embeddings");
    }
}

/**
 * Uses OpenAI to generate an answer based on context and a question.
 * @param {string} context - Context string.
 * @param {string} question - Question to answer.
 * @returns {string} Answer string.
 */
async function getAnswer(context, question) {
    const prompt = `Answer the question based on the context below. If the question can't be answered based on the context, make a reasonable guess.\nContext: ${context}\nQuestion: ${question}\nAnswer:`;
    if (prompt.length > 10000) {
        throw new Error(`Prompt is too long: ${prompt.length} characters`);
    }
    try {
        const response = await openai.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "gpt-4",
        });
        const answer = response.choices[0].message.content;
        console.log(`GPT Answer: ${answer}`);
        return answer;
    } catch (e) {
        console.error("Error calling OpenAI API:", e?.response?.data?.error);
        throw new Error("Error generating answer from OpenAI");
    }
}

export { tokenizeContent, getRelevantTokens, saveRelevantTokensToCsv, getEmbeddings, getAnswer };
