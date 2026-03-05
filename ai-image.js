// ============================================
// NFT-XERIS — AI IMAGE GENERATOR
// ============================================
// Primary: Replicate API with FLUX.1 [schnell]
// Fallback: Mock SVG generator (no API key)
// ============================================
// Model: black-forest-labs/flux-schnell
// https://github.com/black-forest-labs/flux
// ============================================

const crypto = require('crypto');

let replicate = null;

function initReplicate() {
    if (replicate) return replicate;
    if (!process.env.REPLICATE_API_TOKEN) return null;

    try {
        const Replicate = require('replicate');
        replicate = new Replicate({
            auth: process.env.REPLICATE_API_TOKEN
        });
        console.log('[AI] Replicate API initialized (FLUX.1 schnell)');
        return replicate;
    } catch (e) {
        console.error(`[AI] Replicate init failed: ${e.message}`);
        return null;
    }
}

/**
 * Check if real AI generation is available.
 */
function isConfigured() {
    return !!initReplicate();
}

/**
 * Generate an image from a text prompt using FLUX.1 [schnell].
 *
 * @param {string} prompt - Text description of the desired image
 * @param {object} [opts] - Generation options
 * @param {string} [opts.aspectRatio='1:1'] - Aspect ratio
 * @param {string} [opts.outputFormat='webp'] - Output format: webp, png, jpg
 * @param {number} [opts.outputQuality=90] - Compression quality (0-100)
 * @param {number} [opts.seed] - Random seed for reproducibility
 * @returns {Promise<{ imageBuffer: Buffer, mimeType: string, width: number, height: number, prompt: string, model: string, fileExtension: string }>}
 */
async function generateImage(prompt, opts = {}) {
    const sdk = initReplicate();

    if (sdk) {
        return generateWithFlux(sdk, prompt, opts);
    }

    // Fallback to mock SVG
    console.log('[AI] No REPLICATE_API_TOKEN set, using mock SVG generator');
    return generateMockImage(prompt);
}

/**
 * Generate image via Replicate FLUX.1 [schnell].
 */
async function generateWithFlux(sdk, prompt, opts) {
    const aspectRatio = opts.aspectRatio || '1:1';
    const outputFormat = opts.outputFormat || 'webp';
    const outputQuality = opts.outputQuality || 90;

    const input = {
        prompt,
        aspect_ratio: aspectRatio,
        num_outputs: 1,
        num_inference_steps: 4,
        output_format: outputFormat,
        output_quality: outputQuality,
        go_fast: true,
        megapixels: '1'
    };

    if (opts.seed !== undefined) {
        input.seed = opts.seed;
        input.go_fast = false; // Deterministic requires go_fast=false
    }

    console.log(`[AI] Generating with FLUX.1 schnell: "${prompt.substring(0, 50)}..."`);

    const output = await sdk.run('black-forest-labs/flux-schnell', { input });

    if (!output || output.length === 0) {
        throw new Error('No image returned from FLUX model');
    }

    const imageOutput = output[0];

    // Download the image from Replicate CDN
    let imageBuffer;

    if (typeof imageOutput === 'object' && imageOutput.url) {
        // FileOutput object — fetch the URL
        const response = await fetch(imageOutput.url());
        if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
    } else if (typeof imageOutput === 'string') {
        // Direct URL string
        const response = await fetch(imageOutput);
        if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
    } else if (Buffer.isBuffer(imageOutput)) {
        imageBuffer = imageOutput;
    } else {
        // Try ReadableStream (FileOutput implements this)
        try {
            const chunks = [];
            for await (const chunk of imageOutput) {
                chunks.push(chunk);
            }
            imageBuffer = Buffer.concat(chunks);
        } catch (e) {
            throw new Error('Unable to read image output from Replicate');
        }
    }

    const mimeTypes = {
        webp: 'image/webp',
        png: 'image/png',
        jpg: 'image/jpeg'
    };

    // Approximate dimensions based on aspect ratio at 1 megapixel
    const dimensions = getDimensions(aspectRatio);

    console.log(`[AI] FLUX image generated: ${imageBuffer.length} bytes (${outputFormat})`);

    return {
        imageBuffer,
        mimeType: mimeTypes[outputFormat] || 'image/webp',
        width: dimensions.width,
        height: dimensions.height,
        prompt,
        model: 'flux-schnell',
        fileExtension: outputFormat === 'jpg' ? 'jpg' : outputFormat
    };
}

/**
 * Calculate approximate pixel dimensions from aspect ratio at ~1MP.
 */
function getDimensions(aspectRatio) {
    const ratios = {
        '1:1': { width: 1024, height: 1024 },
        '16:9': { width: 1344, height: 768 },
        '21:9': { width: 1536, height: 640 },
        '3:2': { width: 1216, height: 832 },
        '2:3': { width: 832, height: 1216 },
        '4:5': { width: 896, height: 1088 },
        '5:4': { width: 1088, height: 896 },
        '3:4': { width: 896, height: 1152 },
        '4:3': { width: 1152, height: 896 },
        '9:16': { width: 768, height: 1344 },
        '9:21': { width: 640, height: 1536 }
    };
    return ratios[aspectRatio] || ratios['1:1'];
}

// ─── MOCK FALLBACK ──────────────────────────────────────────────────

function generateMockImage(prompt) {
    const hash = crypto.createHash('md5').update(prompt).digest('hex');
    const colors = {
        bg: '#' + hash.substring(0, 6),
        fg: '#' + hash.substring(6, 12),
        accent: '#' + hash.substring(12, 18)
    };
    const brightness = (
        parseInt(hash.substring(0, 2), 16) * 299 +
        parseInt(hash.substring(2, 4), 16) * 587 +
        parseInt(hash.substring(4, 6), 16) * 114
    ) / 1000;
    const textColor = brightness > 128 ? '#1a1a2e' : '#e0e0ff';

    const shaHash = crypto.createHash('sha256').update(prompt).digest();
    const shapes = [];
    const shapeCount = 3 + (shaHash[0] % 5);

    for (let i = 0; i < shapeCount; i++) {
        const offset = i * 4;
        const x = (shaHash[offset % 32] / 255) * 500;
        const y = (shaHash[(offset + 1) % 32] / 255) * 500;
        const size = 30 + (shaHash[(offset + 2) % 32] / 255) * 120;
        const opacity = 0.2 + (shaHash[(offset + 3) % 32] / 255) * 0.6;
        const type = shaHash[(offset + 2) % 32] % 3;
        const color = '#' + shaHash.slice((i * 3) % 29, (i * 3) % 29 + 3).toString('hex').padEnd(6, 'a');

        if (type === 0) {
            shapes.push(`<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`);
        } else if (type === 1) {
            shapes.push(`<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="${size * 0.1}" fill="${color}" opacity="${opacity.toFixed(2)}" transform="rotate(${shaHash[i] % 360}, ${x}, ${y})"/>`);
        } else {
            const points = [];
            for (let j = 0; j < 3 + (shaHash[i] % 3); j++) {
                const angle = (j / (3 + (shaHash[i] % 3))) * Math.PI * 2;
                points.push(`${x + Math.cos(angle) * size / 2},${y + Math.sin(angle) * size / 2}`);
            }
            shapes.push(`<polygon points="${points.join(' ')}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`);
        }
    }

    const displayText = prompt.length > 40 ? prompt.substring(0, 37) + '...' : prompt;
    const escapedText = displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${colors.bg}"/>
      <stop offset="100%" style="stop-color:${colors.accent}"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)" rx="8"/>
  <g filter="url(#glow)">${shapes.join('\n    ')}</g>
  <text x="256" y="40" font-family="monospace" font-size="14" fill="${textColor}" text-anchor="middle" opacity="0.7">XERIS AI NFT</text>
  <rect x="20" y="440" width="472" height="52" rx="6" fill="rgba(0,0,0,0.5)"/>
  <text x="256" y="462" font-family="sans-serif" font-size="11" fill="#e0e0ff" text-anchor="middle">${escapedText}</text>
  <text x="256" y="480" font-family="monospace" font-size="9" fill="#888" text-anchor="middle">AI-Generated Mock</text>
</svg>`;

    return {
        imageBuffer: Buffer.from(svg, 'utf8'),
        mimeType: 'image/svg+xml',
        width: 512,
        height: 512,
        prompt,
        model: 'mock',
        fileExtension: 'svg'
    };
}

module.exports = { generateImage, isConfigured, getDimensions };
