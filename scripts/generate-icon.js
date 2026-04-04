#!/usr/bin/env node
/**
 * Generate app icon SVG → PNG → icns/ico
 * Uses macOS sips + iconutil (no external deps)
 */
const { writeFileSync, mkdirSync, existsSync } = require('fs')
const { execSync } = require('child_process')
const { join } = require('path')

const buildDir = join(__dirname, '..', 'build')
if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true })

// Lightning bolt SVG matching the sidebar logo
// Orange accent (#F05638) on dark background
// Full square — macOS automatically applies its own rounded-rect superellipse mask
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1e2e"/>
      <stop offset="100%" stop-color="#2a2a3e"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#FF7A56"/>
      <stop offset="100%" stop-color="#F05638"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g transform="translate(512,512) scale(14)">
    <path d="M1 -9.5L-8 2.5h7l-2 7 9-11h-7l2-7z"
      fill="url(#bolt)"
      stroke="#FFB090"
      stroke-width="0.8"
      stroke-linecap="round"
      stroke-linejoin="round"/>
  </g>
</svg>`

const svgPath = join(buildDir, 'icon.svg')
writeFileSync(svgPath, svg)
console.log('SVG written:', svgPath)

// Convert SVG → PNG using sips (macOS)
const png1024 = join(buildDir, 'icon.png')

try {
  // Use qlmanage for SVG→PNG (sips doesn't handle SVG well)
  execSync(`qlmanage -t -s 1024 -o "${buildDir}" "${svgPath}"`, { stdio: 'pipe' })
  // qlmanage outputs as icon.svg.png
  const qlOutput = join(buildDir, 'icon.svg.png')
  if (existsSync(qlOutput)) {
    execSync(`mv "${qlOutput}" "${png1024}"`)
  }
} catch {
  // Fallback: try rsvg-convert or just use sips
  try {
    execSync(`rsvg-convert -w 1024 -h 1024 "${svgPath}" -o "${png1024}"`, { stdio: 'pipe' })
  } catch {
    console.log('Neither qlmanage nor rsvg-convert available. Using SVG directly.')
    console.log('Install librsvg: brew install librsvg')
    // Write a simple HTML approach as last resort
  }
}

if (!existsSync(png1024)) {
  console.error('Failed to generate PNG. Please install librsvg: brew install librsvg')
  process.exit(1)
}

console.log('PNG 1024x1024 written:', png1024)

// Generate a rounded PNG for macOS dock (dev mode)
// macOS superellipse: approx 22.37% corner radius
const roundedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1e2e"/>
      <stop offset="100%" stop-color="#2a2a3e"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#FF7A56"/>
      <stop offset="100%" stop-color="#F05638"/>
    </linearGradient>
    <clipPath id="roundClip">
      <rect x="80" y="80" width="864" height="864" rx="190" ry="190"/>
    </clipPath>
  </defs>
  <g clip-path="url(#roundClip)">
    <rect x="80" y="80" width="864" height="864" fill="url(#bg)"/>
    <g transform="translate(512,512) scale(14)">
      <path d="M1 -9.5L-8 2.5h7l-2 7 9-11h-7l2-7z"
        fill="url(#bolt)"
        stroke="#FFB090"
        stroke-width="0.8"
        stroke-linecap="round"
        stroke-linejoin="round"/>
    </g>
  </g>
</svg>`
const roundedSvgPath = join(buildDir, 'icon-rounded.svg')
writeFileSync(roundedSvgPath, roundedSvg)

const pngRounded = join(buildDir, 'icon-rounded.png')
try {
  execSync(`qlmanage -t -s 1024 -o "${buildDir}" "${roundedSvgPath}"`, { stdio: 'pipe' })
  const qlOut = join(buildDir, 'icon-rounded.svg.png')
  if (existsSync(qlOut)) execSync(`mv "${qlOut}" "${pngRounded}"`)
} catch {
  try {
    execSync(`rsvg-convert -w 1024 -h 1024 "${roundedSvgPath}" -o "${pngRounded}"`, { stdio: 'pipe' })
  } catch { /* skip */ }
}
if (existsSync(pngRounded)) {
  console.log('Rounded PNG written:', pngRounded)
} else {
  console.log('Rounded PNG skipped (no converter)')
}

// Generate iconset for macOS .icns
const iconsetDir = join(buildDir, 'icon.iconset')
if (!existsSync(iconsetDir)) mkdirSync(iconsetDir)

const sizes = [16, 32, 64, 128, 256, 512]
for (const size of sizes) {
  execSync(`sips -z ${size} ${size} "${png1024}" --out "${join(iconsetDir, `icon_${size}x${size}.png`)}"`, { stdio: 'pipe' })
  execSync(`sips -z ${size * 2} ${size * 2} "${png1024}" --out "${join(iconsetDir, `icon_${size}x${size}@2x.png`)}"`, { stdio: 'pipe' })
}

// Generate .icns
try {
  execSync(`iconutil -c icns "${iconsetDir}" -o "${join(buildDir, 'icon.icns')}"`, { stdio: 'pipe' })
  console.log('icns written:', join(buildDir, 'icon.icns'))
} catch (e) {
  console.warn('iconutil failed:', e.message)
}

// Clean up iconset
execSync(`rm -rf "${iconsetDir}"`)

console.log('Done! Icons generated in build/')
