import { ApiResponse } from "../types";

const SYSTEM_INSTRUCTION = `You are a world-class Adobe Stock Metadata Expert and SEO Specialist. Your goal is to maximize the commercial success of the provided image by generating a highly optimized title and exact keyword list.

Task: Generate distinct, highly descriptive metadata for the provided image focusing on commercial appeal.

Output Requirements:
1. Title (90-120 Characters):
- Create a compelling, detailed title focusing on the literal main subject, action, context, environment, and mood.
- Include conceptual relevance if applicable (e.g., "growth", "security", "innovation").
- The title MUST be exactly between 90 and 120 characters to maximize search impressions.
- No punctuation (no commas, periods, or hyphens) within the title.

2. Keywords (Exactly 40 Keywords):
- Provide exactly 40 highly relevant, single-word or short-phrase keywords.
- Order matters: Place the most critical, literal, and descriptive keywords in the first 10 spots.
- Include conceptual keywords (emotions, concepts) later in the list.
- All keywords must be separated by commas.

Constraints:
- Return ONLY valid JSON format.
- DO NOT use generic terms like "photo", "image", "picture", "stock", "background" unless strictly relevant.`;

export async function generatePhotoMetadata(
  base64Image: string,
  mimeType: string,
  modelName: string = 'gemini-3-flash-preview',
  apiKey: string
): Promise<ApiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const payload = {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Generate highly optimized stock photography metadata in JSON format as requested." },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: {
            type: "STRING",
            description: "Optimized title, 90-120 characters, no punctuation"
          },
          keywords: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Array of exactly 40 keywords"
          }
        },
        required: ["title", "keywords"]
      }
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API Error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) throw new Error("Empty response from Gemini API");

    return JSON.parse(text) as ApiResponse;
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}
