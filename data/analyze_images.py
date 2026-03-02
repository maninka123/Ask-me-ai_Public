import os
import time
import json
import pandas as pd
from google import genai
from google.genai import types
from tqdm import tqdm

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(os.path.dirname(BASE_DIR), "ai-config.json")
try:
    with open(CONFIG_PATH, 'r') as f:
        config = json.load(f)
except Exception as e:
    print(f"Error loading config: {e}")
    config = {"personName": "Pasindu", "imagesFolder": "Images"}

person_name = config.get("personName", "Pasindu")
INPUT_DIR = os.path.join(BASE_DIR, config.get("imagesFolder", "Images"))
OUTPUT_CSV = os.path.join(BASE_DIR, "image_metadata.csv")

# Load API key from environment or .env.local
env_path = os.path.join(os.path.dirname(BASE_DIR), ".env.local")
api_key = os.environ.get("GEMINI_API_KEY")

if not api_key and os.path.exists(env_path):
    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                break

if not api_key:
    print("Error: No GEMINI_API_KEY found in environment or .env.local")
    exit(1)

client = genai.Client(api_key=api_key)
model_name = config.get("imageAnalysisModel", "gemini-2.5-flash")

def analyze_image_with_gemini(image_path, filename):
    prompt = f"""
    Analyze this image in extreme detail. 
    The filename is '{filename}'. It is CRITICAL that you extract any context, location, or subject clues directly from this filename (e.g., if it says "self driving car", the main subject is a self driving car).

    The person who took the photo is named '{person_name}'. If there is only one person or a few people in the photo, you MUST assume {person_name} is present.
    If {person_name} is present and there is no other overwhelming subject (like a car or big landmark being the explicit focus), then {person_name} IS the Main Subject.

    You MUST extract the exact Location (Country, City, Specific Place) if possible, the Main Subject, whether {person_name} is present, People descriptions, and General Context.
    """

    # print(f"Analyzing {filename} with Gemini...") # removed print to not break tqdm bar
    
    retry_delays = [0, 1, 3]  # seconds (very fast since on paid tier)

    for attempt, delay in enumerate(retry_delays):
        if delay > 0:
            print(f"  Waiting {delay}s before retry...")
            time.sleep(delay)
        try:
            uploaded_file = client.files.upload(file=image_path)
            
            response = client.models.generate_content(
                model=model_name,
                contents=[uploaded_file, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema={
                        "type": "OBJECT",
                        "properties": {
                            "Country": {
                                "type": "STRING",
                                "description": "The country where this was taken, if identifiable from the image or filename. Otherwise 'Unknown'."
                            },
                            "City": {
                                "type": "STRING",
                                "description": "The city where this was taken, if identifiable from the image or filename. Otherwise 'Unknown'."
                            },
                            "Specific_Place": {
                                "type": "STRING",
                                "description": "The exact landmark, building, or specific place, if identifiable. Otherwise 'Unknown'."
                            },
                            "Main_Subject": {
                                "type": "STRING",
                                "description": f"The primary focus of the image (e.g., '{person_name}', 'Self driving car', 'Group of friends'). USE FILENAME CLUES."
                            },
                            "Is_Person_Present": {
                                "type": "BOOLEAN",
                                "description": f"True if there is one or a few people in the photo (assuming one is {person_name}) or if the filename implies {person_name} is present."
                            },
                            "People": {
                                "type": "STRING",
                                "description": "Describe all people in the photo."
                            },
                            "Context": {
                                "type": "STRING",
                                "description": "A 1-2 sentence description of the overall scene, action, and vibe."
                            }
                        },
                        "required": ["Country", "City", "Specific_Place", "Main_Subject", "Is_Person_Present", "People", "Context"]
                    },
                    temperature=0.2
                )
            )
            
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                pass 

            print(f"  ✓ Success on attempt {attempt + 1}")
            return response.text
            
        except Exception as e:
            is_rate_limit = "429" in str(e) or "Quota" in str(e) or "RESOURCE_EXHAUSTED" in str(e)
            print(f"  Attempt {attempt + 1} failed: {e}")
            if is_rate_limit:
                continue  # try next delay
            else:
                break  # non-rate-limit error, skip
    
    print(f"  All retries exhausted for {filename}. Skipping.")
    return None

def main():
    if not os.path.exists(INPUT_DIR):
        print(f"Input directory not found: {INPUT_DIR}")
        return

    results = []
    processed_files = set()

    # Read existing CSV so we don't re-process images
    if os.path.exists(OUTPUT_CSV):
        try:
            df = pd.read_csv(OUTPUT_CSV)
            results = df.to_dict('records')
            processed_files = set(df['Filename'].tolist())
            print(f"Found existing CSV with {len(processed_files)} processed images. Resuming...")
        except Exception as e:
            print(f"Error reading existing CSV: {e}. Starting fresh.")

    valid_extensions = ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.heic')
    all_files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith(valid_extensions)]
    
    # Check for deleted files and remove them from CSV
    if results:
        current_file_set = set(all_files)
        files_to_remove = processed_files - current_file_set
        
        if files_to_remove:
            print(f"Found {len(files_to_remove)} deleted images. Removing from CSV...")
            results = [row for row in results if row.get('Filename') not in files_to_remove]
            processed_files = processed_files - files_to_remove
            # immediately save synced CSV
            df = pd.DataFrame(results)
            df.to_csv(OUTPUT_CSV, index=False)
            print("CSV synced.")

    files_to_process = [f for f in all_files if f not in processed_files]
    print(f"Found {len(files_to_process)} new images to process and extract detailed metadata from.")

    for i, filename in enumerate(tqdm(files_to_process, desc="Analyzing images")):
        in_path = os.path.join(INPUT_DIR, filename)
        # Analyzing original image from INPUT_DIR

        response_text = analyze_image_with_gemini(in_path, filename)
        
        if response_text:
            try:
                # Gemini natively returns the strict JSON string based on our schema
                parsed_data = json.loads(response_text)
                
                row = {
                    "Filename": filename,
                    "Country": parsed_data.get("Country", "Unknown"),
                    "City": parsed_data.get("City", "Unknown"),
                    "Specific Place": parsed_data.get("Specific_Place", "Unknown"),
                    "Main Subject": parsed_data.get("Main_Subject", "Unknown"),
                    "Is Person Present": parsed_data.get("Is_Person_Present", False),
                    "People": parsed_data.get("People", "Unknown"),
                    "Context": parsed_data.get("Context", "Unknown")
                }
                results.append(row)
                
                if (i + 1) % 5 == 0 or i == len(files_to_process) - 1:
                    df = pd.DataFrame(results)
                    df.to_csv(OUTPUT_CSV, index=False)
                    # tqdm.write(f"--- Progress saved. Processed {len(results)}/{len(files_to_process)} images ---")
                    
                # Removed time.sleep(5) completely for paid tier
            except json.JSONDecodeError as e:
                tqdm.write(f"Failed to parse JSON for {filename}: {e}")
        else:
            tqdm.write(f"Failed to get response for {filename}. Skipping for now.")

    if results:
        df = pd.DataFrame(results)
        df.to_csv(OUTPUT_CSV, index=False)
        print(f"\nSuccessfully finished! Detailed metadata saved to: {OUTPUT_CSV}")
    else:
        print("\nNo images were successfully processed.")

if __name__ == "__main__":
    main()
