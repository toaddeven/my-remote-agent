/**
 * Skill Loader
 *
 * Loads skill definitions from a directory by reading SKILL.md files.
 * Each subdirectory containing a SKILL.md is treated as a skill.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('skills:loader');

/** A skill definition parsed from a SKILL.md file. */
export interface SkillDefinition {
  /** Unique name of the skill (derived from the directory name). */
  name: string;
  /** Human-readable description extracted from the SKILL.md front matter or first line. */
  description: string;
  /** Absolute path to the skill directory. */
  location: string;
}

const SKILL_FILE = 'SKILL.md';

/**
 * Extract the skill description from the SKILL.md content.
 *
 * Looks for:
 * 1. A YAML-style "description:" front-matter field
 * 2. The first non-empty, non-heading line as a fallback
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');

  // Check for YAML front-matter description
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '---') break;
      if (line.startsWith('description:')) {
        return line.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  // Fallback: first non-empty, non-heading line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      // Use heading text (strip # prefix)
      return trimmed.replace(/^#+\s*/, '');
    }
    return trimmed;
  }

  return '';
}

/**
 * Load all skills from the given directory.
 *
 * Scans immediate subdirectories for SKILL.md files and parses them
 * into SkillDefinition objects.
 *
 * @param dir - Absolute path to the skills directory
 * @returns Array of loaded skill definitions
 */
export async function loadSkills(dir: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Directory doesn't exist or isn't readable — that's fine, return empty
    logger.debug(`Skills directory not readable: ${dir}`, String(err));
    return skills;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);

    // Only process directories
    let entryStat;
    try {
      entryStat = await stat(entryPath);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    // Look for SKILL.md
    const skillFilePath = join(entryPath, SKILL_FILE);
    let content: string;
    try {
      content = await readFile(skillFilePath, 'utf-8');
    } catch {
      // No SKILL.md in this directory — skip
      continue;
    }

    const name = basename(entryPath);
    const description = extractDescription(content);

    skills.push({
      name,
      description,
      location: entryPath,
    });

    logger.debug(`Loaded skill: ${name}`, { location: entryPath });
  }

  logger.info(`Loaded ${skills.length} skill(s) from ${dir}`);
  return skills;
}
