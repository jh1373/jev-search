// Locate the Obsidian executable without hardcoding a developer's home directory.
//
// The GUI acceptance tests drive a real Obsidian. Hardcoding one machine's path leaks a personal
// directory into the repository and breaks every other machine, so the path is resolved here instead:
// an explicit OBSIDIAN_EXE wins, otherwise the usual install locations are tried.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function obsidianCandidates() {
  const candidates = [];
  if (process.env.OBSIDIAN_EXE) candidates.push(process.env.OBSIDIAN_EXE);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'));
  if (process.env.PROGRAMFILES) candidates.push(join(process.env.PROGRAMFILES, 'Obsidian', 'Obsidian.exe'));
  if (process.env['PROGRAMFILES(X86)']) candidates.push(join(process.env['PROGRAMFILES(X86)'], 'Obsidian', 'Obsidian.exe'));
  candidates.push('/Applications/Obsidian.app/Contents/MacOS/Obsidian');
  candidates.push('/usr/bin/obsidian');
  return candidates.filter(Boolean);
}

export function obsidianExe() {
  const found = obsidianCandidates().find(path => existsSync(path));
  if (!found) throw new Error('Obsidian not found. Set OBSIDIAN_EXE. Tried: ' + obsidianCandidates().join(', '));
  return found;
}
