import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export async function GET(req, { params }) {
    const resolvedParams = await params;
    let filename = resolvedParams.filename;
    const dataDir = path.join(process.cwd(), 'data', 'Images');
    let filePath = path.join(dataDir, filename);

    // Fallback: if the file wasn't found, try swapping .jpeg → .jpg
    // (Gemini might refer to a file with a slightly different extension)
    if (!fs.existsSync(filePath)) {
        const jpgFallback = filename.replace(/\.jpe?g$/i, '.jpg');
        const fallbackPath = path.join(dataDir, jpgFallback);
        if (fs.existsSync(fallbackPath)) {
            filename = jpgFallback;
            filePath = fallbackPath;
        } else {
            return new NextResponse('Not Found', { status: 404 });
        }
    }

    // Very basic security check to avoid directory traversal
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(dataDir))) {
        return new NextResponse('Forbidden', { status: 403 });
    }

    const stat = fs.statSync(filePath);

    const ext = path.extname(filename).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.svg') contentType = 'image/svg+xml';

    const buffer = fs.readFileSync(filePath);

    return new NextResponse(buffer, {
        headers: {
            'Content-Type': contentType,
            'Content-Length': stat.size.toString(),
            'Cache-Control': 'public, max-age=86400',
        }
    });
}
