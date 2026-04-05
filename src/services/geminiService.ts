import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function getMapsGrounding(prompt: string, location?: { lat: number; lng: number }) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleMaps: {} }],
        toolConfig: {
          retrievalConfig: {
            latLng: location ? { latitude: location.lat, longitude: location.lng } : undefined
          }
        }
      },
    });

    return {
      text: response.text,
      chunks: response.candidates?.[0]?.groundingMetadata?.groundingChunks || []
    };
  } catch (error) {
    console.error("Maps grounding error:", error);
    return { text: "Location services currently unavailable.", chunks: [] };
  }
}

export async function estimateFare(pickup: string, dropoff: string) {
  try {
    const prompt = `Estimate the distance and cab fare between ${pickup} and ${dropoff} in Indian Rupees. 
    Provide estimates for 3 categories: Mini (Base), Sedan (Premium), and SUV (Large).
    Return only a JSON object with this structure:
    { 
      "distance": number (km), 
      "options": [
        { "type": "Mini", "fare": number },
        { "type": "Sedan", "fare": number },
        { "type": "SUV", "fare": number }
      ]
    }`;
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            distance: { type: Type.NUMBER },
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  fare: { type: Type.NUMBER }
                },
                required: ["type", "fare"]
              }
            }
          },
          required: ["distance", "options"]
        }
      }
    });

    return JSON.parse(response.text || "{}");
  } catch (error) {
    console.error("Fare estimation error:", error);
    return { 
      distance: 12, 
      options: [
        { type: "Mini (AC)", fare: 180 },
        { type: "Sedan (AC)", fare: 280 },
        { type: "SUV (AC)", fare: 450 },
        { type: "Ertiga (9 Seater)", fare: 550 },
        { type: "Tempo (AC)", fare: 750 }
      ] 
    }; // Robust Fallback
  }
}

export async function getRealDistance(pickup: string, dropoff: string): Promise<number> {
  try {
    const prompt = `Find the precise driving distance in kilometers between "${pickup}" and "${dropoff}". 
    Use Google Search to find the most accurate current road distance.
    Return ONLY the numeric value in km (e.g., 12.5). Do not include any text or units.`;
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const distanceText = response.text?.match(/\d+(\.\d+)?/)?.[0];
    const distance = distanceText ? parseFloat(distanceText) : 10;
    console.log(`Gemini distance for ${pickup} to ${dropoff}: ${distance}km`);
    return distance;
  } catch (error) {
    console.error("Distance search error:", error);
    return 10; // Fallback
  }
}
