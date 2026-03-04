// ============================================
// NFT-XERIS — MOCK AI IMAGE GENERATOR
// ============================================
// Generates placeholder SVG images from prompts.
// Swap for real AI API (DALL-E, Stability) later.
// ============================================

const crypto = require('crypto');

// Generate a deterministic color palette from the prompt
function promptToColors(prompt) {
    const hash = crypto.createHash('md5').update(prompt).digest('hex');
    return {
        bg: '#' + hash.substring(0, 6),
        fg: '#' + hash.substring(6, 12),
        accent: '#' + hash.substring(12, 18),
        text: getBrightness(hash.substring(0, 6)) > 128 ? '#1a1a2e' : '#e0e0ff'
    };
}

function getBrightness(hex) {
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000;
}

// Generate abstract geometric shapes based on prompt hash
function generateShapes(prompt) {
    const hash = crypto.createHash('sha256').update(prompt).digest();
    const shapes = [];
    const shapeCount = 3 + (hash[0] % 5);

    for (let i = 0; i < shapeCount; i++) {
        const offset = i * 4;
        const x = (hash[offset % 32] / 255) * 500;
        const y = (hash[(offset + 1) % 32] / 255) * 500;
        const size = 30 + (hash[(offset + 2) % 32] / 255) * 120;
        const opacity = 0.2 + (hash[(offset + 3) % 32] / 255) * 0.6;
        const type = hash[(offset + 2) % 32] % 3;

        const color = '#' + hash.slice((i * 3) % 29, (i * 3) % 29 + 3).toString('hex').padEnd(6, 'a');

        if (type === 0) {
            shapes.push(`<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`);
        } else if (type === 1) {
            shapes.push(`<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="${size * 0.1}" fill="${color}" opacity="${opacity.toFixed(2)}" transform="rotate(${hash[i] % 360}, ${x}, ${y})"/>`);
        } else {
            const points = [];
            for (let j = 0; j < 3 + (hash[i] % 3); j++) {
                const angle = (j / (3 + (hash[i] % 3))) * Math.PI * 2;
                points.push(`${x + Math.cos(angle) * size / 2},${y + Math.sin(angle) * size / 2}`);
            }
            shapes.push(`<polygon points="${points.join(' ')}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`);
        }
    }
    return shapes.join('\n    ');
}

// Truncate prompt text for display
function truncatePrompt(prompt, maxLen = 40) {
    if (prompt.length <= maxLen) return prompt;
    return prompt.substring(0, maxLen - 3) + '...';
}

/**
 * Generate a placeholder image from a prompt.
 * @param {string} prompt - The text prompt
 * @returns {{ imageBuffer: Buffer, mimeType: string, width: number, height: number, prompt: string }}
 */
function generateImage(prompt) {
    const colors = promptToColors(prompt);
    const shapes = generateShapes(prompt);
    const displayText = truncatePrompt(prompt);

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

  <!-- Background -->
  <rect width="512" height="512" fill="url(#bg)" rx="8"/>

  <!-- Abstract shapes from prompt -->
  <g filter="url(#glow)">
    ${shapes}
  </g>

  <!-- Xeris branding -->
  <text x="256" y="40" font-family="monospace" font-size="14" fill="${colors.text}" text-anchor="middle" opacity="0.7">XERIS AI NFT</text>

  <!-- Prompt text -->
  <rect x="20" y="440" width="472" height="52" rx="6" fill="rgba(0,0,0,0.5)"/>
  <text x="256" y="462" font-family="sans-serif" font-size="11" fill="#e0e0ff" text-anchor="middle">${escapeXml(displayText)}</text>
  <text x="256" y="480" font-family="monospace" font-size="9" fill="#888" text-anchor="middle">AI-Generated Mock</text>
</svg>`;

    return {
        imageBuffer: Buffer.from(svg, 'utf8'),
        mimeType: 'image/svg+xml',
        width: 512,
        height: 512,
        prompt
    };
}

function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateImage };
