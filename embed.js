
import csvParser from "csv-parser";
import createCsvWriter from "csv-writer";
import dotenv from "dotenv";
import fs from "fs";
//import { createRequire } from  "module";
import path from "path";
import { URL } from "url";
import { parse } from "node-html-parser";
import natural from "natural";

import { OpenAI } from "openai";

const MAXCOUNT = 10;

dotenv.config();
// get local directory path

// get OPENAI_API_KEY from GitHub secrets
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// check if url has https:// if it does strip it out for domain

/**
 * Takes an HTML content string as input.
 * Returns an array of tokenized words.
 * @param {string} content - The HTML content string.
 * @returns {string[]} The array of tokenized words.
 */
async function tokenizeContent(content) {
    const cleanContent = removeHTMLElementNamesFromString(content);
    const tokenizer = new natural.WordTokenizer();
    const tokens = tokenizer.tokenize(cleanContent);
    return tokens.slice(0, 3000);
}

function removeHTMLElementNamesFromString(stringContent) {
    const regex =
        /\b(div|span|li|a|ul|section|script|footer|body|html|link|img|href|svg|alt|target|js|javascript|lang|head|gtag|meta|charset|utf|woff2|crossorigin|anonymous|link|rel|preload|as|font|href|assets|fonts|Inter|UI|var|woff2|type|font|css|stylesheet|text)\b/g;
    return stringContent.replace(regex, "");
}

/**
 * Takes a set of visited URLs and an output file path as input.
 * Saves the visited URLs to a CSV file.
 * @param {Set<string>} visitedUrls - The set of visited URLs.
 * @param {string} outputPath - The output file path.
 */



async function getRelevantTokens(tokens) {
    console.log("start getRelevantTokens");
    const tokenString = typeof tokens === "string" ? tokens : tokens.join(" ");
    // Prepare the prompt for OpenAI's Codex
    const promptStart = `Given the following tokenized text, identify the most relevant tokens:\n\n`;
    const promptEnd = `\n\nRelevant tokens:`;

    // calculate the tokens available for the actual content
    const availableTokens = 4096 - promptStart.length - promptEnd.length;

    let prompt;
    if (tokenString.length > availableTokens) {
        // cut the string to fit available tokens
        prompt = promptStart + tokenString.slice(0, availableTokens) + promptEnd;
    } else {
        prompt = promptStart + tokenString + promptEnd;
    }

    // Call the OpenAI API
    let response;
    try {
        console.log("initiating openai api call");
        response = await openai.completions.create({
            model: "gpt-3.5-turbo-instruct",
            prompt: prompt,
            max_tokens: 2000,
            n: 1,
            stop: null,
            temperature: 0.8,
        });
    } catch (e) {
        console.error(
            "Error calling OpenAI API getRelevantTokens completions.create:",
            e?.response?.data?.error
        );
        throw new Error(
            "Error calling OpenAI API getRelevantTokens completions.create"
        );
    }

    console.log("finished getRelevantTokens");

    // Extract and return the relevant tokens from the response
    const relevantTokensText = response?.choices[0].text.trim();
    const relevantTokens = relevantTokensText.split(" ");
    console.log(relevantTokens);
    return relevantTokens;
}

/**
 * Takes an array of tokenized contents and an output file path as input.
 * Saves the most relevant tokens to a CSV file.
 * @param {object[]} tokenizedContents - The array of tokenized contents.
 * @param {string} outputPath - The output file path.
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
            model: "text-embedding-ada-002",
            input: tokens,
            embedding_format: "float"
        });
        return response.data[0].embedding;
    } catch (e) {
        console.error("Error calling OpenAI API getEmbeddings:", e?.response?.data[0]);
        throw new Error("Error calling OpenAI API getEmbeddings");
    }

    
}

/**
 * Takes two arrays of numbers as input.
 * Returns the cosine similarity between the two arrays.
 * @param {number[]} a - The first array of numbers.
 * @param {number[]} b - The second array of numbers.
 * @returns {number} The cosine similarity between the two arrays.
 */
function cosineSimilarity(a, b) {
    if (!a || !b) return;
    console.log("start cosineSimilarity", a, b);
    const dotProduct = a.reduce((sum, _, i) => sum + a[i] * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Takes an input text string and crawled data as input.
 * Returns an array of similarity scores along with their corresponding URLs.
 * @param {string} inputText - The input text string.
 * @param {object} crawledData - The crawled data.
 * @returns {object[]} The array of similarity scores along with their corresponding URLs.
 */
async function calculateSimilarityScores(inputText, crawledData) {
    console.log("start calculateSimilarityScores");
    const inputTokens = await tokenizeContent(inputText);
    const inputRelevantTokens = await getRelevantTokens(inputTokens);
    const inputEmbedding = await getEmbeddings(inputRelevantTokens)[0];

    const similarityScores = [];

    for (const { url, tokens } of crawledData.contents) {
        const relevantTokens = await getRelevantTokens(tokens);
        const contentEmbedding = await getEmbeddings(relevantTokens)[0];

        const avgEmbedding = [];
        for (let i = 0; i < inputEmbedding?.length; i++) {
            avgEmbedding[i] = (inputEmbedding[i] + contentEmbedding[i]) / 2;
        }

        const similarityScore =
            cosineSimilarity(inputEmbedding, avgEmbedding) *
            cosineSimilarity(contentEmbedding, avgEmbedding);
        similarityScores.push({ url, similarityScore });
    }

    console.log("finish calculateSimilarityScores");
    return similarityScores;
}

function stripHtmlTags(htmlContent) {
    // Regular expression to match HTML tags and other irrelevant content
    const regex = /(<([^>]+)>|\[.*?\])/gi;

    // Replace all matches with an empty string
    const strippedContent = htmlContent.replace(regex, "");

    // Return the stripped content
    return strippedContent;
}
async function getAnswer(context, question) {
    let prompt = `Answer the question based on the context below. If the question can't be answered based on the context, make a reasonable guess.\n Context: ${context}\n---\n\nQuestion: ${question}\nAnswer:`;
    // chekc that the prompt is not too long
    if (prompt.length > 10000) {
        throw new Error(`Prompt is too long: ${prompt.length} characters`);
    }
    let response;
    let answer;
    try {
        console.log(`Initiating OpenAI API call with prompt: ${prompt}`);
        response = await openai.completions.create({
            model: "gpt-3.5-turbo-instruct",
            prompt: prompt,
            max_tokens: 10000,
            n: 1,
            stop: null,
            temperature: 0.4,
        });
        answer = response.choices[0].text.trim();
        console.log(`GPT Answer: ${answer}`);
        return answer;
    } catch (e) {
        console.error("Error calling OpenAI API:", e?.response?.data?.error);
    }
}


export {getEmbeddings, getAnswer};