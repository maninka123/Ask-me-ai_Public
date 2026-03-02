import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';

// Module-level cache — data is parsed once per server cold start, not on every request
let cachedData = null;

export async function getPersonalData() {
  if (cachedData) return cachedData;
  const baseDir = path.join(process.cwd(), 'data');
  const textDataDir = path.join(baseDir, 'Text data');
  const imagesDir = path.join(baseDir, 'Images');
  const metadataCsv = path.join(baseDir, 'image_metadata.csv');

  let textContent = "";
  let images = [];

  // Parse the image metadata CSV - format it cleanly so Gemini always uses the Filename
  if (fs.existsSync(metadataCsv)) {
    try {
      const content = fs.readFileSync(metadataCsv, 'utf-8');
      const lines = content.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const cartoonIdx = headers.indexOf('Filename');
      const countryIdx = headers.indexOf('Country');
      const cityIdx = headers.indexOf('City');
      const subjectIdx = headers.indexOf('Main Subject');
      const contextIdx = headers.indexOf('Context');

      textContent += `\n\n--- IMAGE METADATA DATABASE ---\n`;
      textContent += `Use ONLY the "USE THIS FILENAME" value below when outputting [IMAGE:] tags. Never use any other filename.\n\n`;

      for (let i = 1; i < lines.length; i++) {
        // Handle CSV with quoted fields
        const cols = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) || [];
        const clean = (v) => (v || '').replace(/^"|"$/g, '').trim();
        const cartoon = clean(cols[cartoonIdx]);
        if (!cartoon) continue;
        textContent += `USE THIS FILENAME: ${cartoon} | Location: ${clean(cols[cityIdx])}, ${clean(cols[countryIdx])} | Subject: ${clean(cols[subjectIdx])} | Context: ${clean(cols[contextIdx])}\n`;
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Parse Text data directory
  if (fs.existsSync(textDataDir)) {
    const files = fs.readdirSync(textDataDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const filePath = path.join(textDataDir, file);

      // Skip the Raw directory just in case it's caught
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) continue;

      if (['.txt', '.md', '.json', '.csv', '.log'].includes(ext)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          textContent += `\n\n--- Source: ${file} ---\n${content}`;
        } catch (err) {
          console.error(`Error reading text file ${file}`, err);
        }
      } else if (ext === '.docx') {
        try {
          const result = await mammoth.extractRawText({ path: filePath });
          textContent += `\n\n--- Source: ${file} ---\n${result.value}`;
        } catch (err) {
          console.error(`Error reading docx file ${file}`, err);
        }
      }
    }
  }

  // Load available Images
  if (fs.existsSync(imagesDir)) {
    const imgFiles = fs.readdirSync(imagesDir);
    for (const file of imgFiles) {
      if (file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg') || file.toLowerCase().endsWith('.png') || file.toLowerCase().endsWith('.webp')) {
        images.push(file);
      }
    }
  }

  cachedData = { textContent, images };
  return cachedData;
}
