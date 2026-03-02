import { ApiResponse } from "../types";

const SYSTEM_INSTRUCTION = `You are a world-class Adobe Stock Metadata Expert and SEO Specialist. Your goal is to maximize the commercial success of the provided image by generating a highly optimized title and exact keyword list.

Task: Generate distinct, highly descriptive metadata for the provided image description focusing on commercial appeal.

Output Requirements:
1. Title (90-120 Characters):
- Create a compelling, detailed title focusing on the literal main subject, action, context, environment, and mood.
- Include conceptual relevance if applicable.
- The title MUST be exactly between 90 and 120 characters.
- No punctuation (no commas, periods, or hyphens) within the title.

2. Keywords (Exactly 40 Keywords):
- Provide exactly 40 highly relevant, single-word or short-phrase keywords.
- Order matters: Place the most critical, literal, and descriptive keywords in the first 10 spots.
- All keywords must be separated by commas.

Constraints:
- Return ONLY valid JSON format with keys "title" and "keywords" (an array of strings).
- DO NOT use generic terms like "photo", "image", "picture".
- Output NOTHING BUT JSON.`;

export async function generatePhotoMetadataWithGroq(
    base64Image: string,
    modelName: string,
    apiKey: string
): Promise<ApiResponse> {
    // Since Groq Vision might not be fully supported on all models, we'll use a reliable multimodal model if available,
    // or instruct the user to use Gemini for vision, but LLaMA 3.2 11B/90B Vision supports images.

    const body = {
        model: modelName,
        messages: [
            {
                role: "system",
                content: SYSTEM_INSTRUCTION
            },
            {
                role: "user",
                content: [
                    { type: "text", text: "Generate highly optimized stock photography metadata in JSON format as requested." },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
            }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
    };

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `Groq API Error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) throw new Error("Empty response from Groq");

    return JSON.parse(content) as ApiResponse;
}
