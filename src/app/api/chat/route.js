import { GoogleGenAI } from '@google/genai';
import { getPersonalData } from '@/utils/dataLoader';
import fs from 'fs';
import path from 'path';
import config from '@/utils/config';

export const runtime = 'nodejs';

export async function POST(req) {
    try {
        // Initialize Gemini with key from env
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing from environment.");

        // Get Vercel location headers (City and Country only)
        const city = req.headers.get('x-vercel-ip-city') || 'Unknown';
        const country = req.headers.get('x-vercel-ip-country') || 'Unknown';

        const { messages } = await req.json();

        // Load context data from the /data folder
        const { textContent, images } = await getPersonalData();

        const systemPrompt = `${config.aiPersona}
You know everything about ${config.personName} from the personal data provided below.

### Formatting
- Your output is displayed in a plain-text terminal. NEVER use markdown formatting like **bold**, *italic*, ### headings.
- Write in normal mixed case (not ALL CAPS). Just write naturally.

### Personality
- ${config.aiTone}
- When someone says "hi" or greets you, respond personally as ${config.personName} — introduce yourself briefly and invite them to ask about your life, projects, or adventures.
- Answer in a storytelling style — engaging, fun, like you're telling a friend about your life. But keep it concise and natural, about 4-6 lines. Don't ramble.
- If the data required to answer a personal question is NOT directly in the context, make a thoughtful guess based on what you DO know about ${config.personName}. Connect the dots from ${config.pronouns.possessive} background, family, and interests. Just mention briefly that you're piecing it together from what you know.
- If the user asks a generic question (not about you), answer it briefly and naturally.

### Images and CSV Metadata
- You have a database of images in the 'IMAGE METADATA DATABASE' below with 'Filename', 'Location', 'Main Subject', 'Context', etc.
- When answering, first give your full story/answer as normal text. Then, at the END of your response (before the [FOLLOWUP] tag), add a blank line followed by any relevant images in narrative order. Show 1 to 4 images if relevant.
- To display an image output EXACTLY this format on its own line: [IMAGE: Filename.jpg | Short human caption 5-8 words]
- Use the EXACT "USE THIS FILENAME" value from the database. Include a brief, natural caption after the | pipe.
- NEVER use standard markdown for images. Only the [IMAGE:] tag works.
- CRITICAL: NEVER describe images in plain text instead of using the [IMAGE:] tag. Do NOT write things like "Here's a photo of..." or "He's seen here at..." to describe a photo without also outputting the [IMAGE:] tag. If you mention a visual, you MUST output the tag.
- CRITICAL: NEVER explain the [IMAGE:] tag system to the user. If the user says they cannot see images, just re-emit the [IMAGE:] tags for the same photos rather than explaining how the system works.
- Add 1-2 lines briefly referencing the images (e.g. "Here are a few shots from that trip...") — keep it short.
- IMPORTANT: Do NOT reuse an image that has already appeared earlier in the conversation.

### Follow-up Questions
At the end of your message, suggest ONE specific, interesting follow-up question a curious visitor might genuinely want to ask next — something concrete about ${config.personName}'s life, work, travels, or personality. Output it on its own line like:
[FOLLOWUP: <specific question>]
NEVER use generic fillers like "What else would you like to know about ${config.personName}?" — make it specific and intriguing.

### My Personal Data
${textContent}
`;

        // Format messages for Gemini genai SDK
        // Strip internal display tags from history so Gemini doesn't think images are "used up"
        const stripTags = (text) => text
            .replace(/\[IMAGE:\s*[^\]]+\]/g, '')
            .replace(/\[CAPTION:\s*[^\]]+\]/g, '')
            .replace(/\[FOLLOWUP:\s*[^\]]+\]/g, '')
            .trim();

        // Only send the last 8 messages to Gemini to prevent context overflow
        // (full personal data system prompt + long history eats all available tokens)
        const recentMessages = messages.slice(-8);
        const formattedMessages = recentMessages.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.role === 'model' ? stripTags(msg.content) : msg.content }]
        }));

        let responseStream = null;

        const ai = new GoogleGenAI({ apiKey: apiKey });
        responseStream = await ai.models.generateContentStream({
            model: config.chatModel || 'gemini-2.5-flash',
            contents: formattedMessages,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.7,
                maxOutputTokens: 2500,
                thinkingConfig: { thinkingBudget: 0 } // Disable thinking to avoid long first-byte delay on Vercel
            }
        });

        // Create a ReadableStream to stream the response back to client
        // Also accumulate the full response text for silent developer logging
        const userQuestion = messages.filter(m => m.role === 'user').pop()?.content || '';
        let fullResponseText = '';

        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                try {
                    for await (const chunk of responseStream) {
                        if (chunk.text) {
                            fullResponseText += chunk.text;
                            controller.enqueue(encoder.encode(chunk.text));
                        }
                        // Log if the model stopped early
                        if (chunk.candidates?.[0]?.finishReason && chunk.candidates[0].finishReason !== 'STOP') {
                            console.warn('Model finish reason:', chunk.candidates[0].finishReason);
                        }
                    }
                    controller.close();

                    // Log the Q&A to Supabase cloud DB
                    if (config.recordDataInDatabase) {
                        try {
                            const supabaseUrl = process.env.SUPABASE_URL;
                            const supabaseKey = process.env.SUPABASE_KEY;

                            if (supabaseUrl && supabaseKey) {
                                const { createClient } = require('@supabase/supabase-js');
                                const supabase = createClient(supabaseUrl, supabaseKey);

                                const { error: dbError } = await supabase
                                    .from('chat_logs')
                                    .insert([{
                                        question: userQuestion,
                                        answer: fullResponseText,
                                        city: city,
                                        country: country
                                    }]);

                                if (dbError) console.error('Supabase insert error:', dbError);
                            }
                        } catch (dbErr) {
                            console.error('Database log error:', dbErr);
                        }
                    }

                    // Save local backup only when running locally (not on Vercel)
                    if (!process.env.VERCEL) {
                        try {
                            const logDir = path.join(process.cwd(), 'data');
                            const logFile = path.join(logDir, '.chat_log.jsonl');
                            const logEntry = JSON.stringify({
                                timestamp: new Date().toISOString(),
                                question: userQuestion,
                                answer: fullResponseText
                            }) + '\n';
                            fs.appendFileSync(logFile, logEntry, 'utf-8');
                        } catch (logErr) {
                            // Ignore
                        }
                    }
                } catch (error) {
                    console.error('Stream error:', error.message);
                    // Send error text to client so they see what happened
                    try {
                        controller.enqueue(encoder.encode(`\n\n[Stream error: ${error.message}]`));
                    } catch (_) { }
                    controller.close();
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Transfer-Encoding': 'chunked',
                'X-Accel-Buffering': 'no',
            }
        });

    } catch (error) {
        console.error('API Error:', error.message, error.status || '', error.stack || '');
        const status = error.status === 429 ? 429 : 500;
        const msg = error.status === 429
            ? 'Gemini API rate limit hit. Please wait a moment and try again.'
            : (error.message || 'Internal Server Error');
        return new Response(JSON.stringify({ error: msg }), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
