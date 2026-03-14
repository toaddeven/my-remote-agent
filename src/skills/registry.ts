/**
 * Skill Registry
 *
 * Stores and retrieves skill definitions. Supports simple keyword-based
 * matching to find skills relevant to a query.
 */

import { createLogger } from '../utils/logger.js';
import type { SkillDefinition } from './loader.js';

const logger = createLogger('skills:registry');

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  /** Register a skill definition. Overwrites if the name already exists. */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    logger.debug(`Skill registered: ${skill.name}`);
  }

  /** Register multiple skills at once. */
  registerAll(skills: Iterable<SkillDefinition>): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /** Retrieve a skill by exact name. Returns undefined if not found. */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** List all registered skills. */
  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** Return the number of registered skills. */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Match skills against a query string using simple keyword matching.
   *
   * Splits the query into lowercase tokens and scores each skill by how many
   * tokens appear in its name or description. Returns skills with at least one
   * match, sorted by relevance (highest score first).
   */
  match(query: string): SkillDefinition[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (tokens.length === 0) {
      return this.list();
    }

    const scored: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const skill of this.skills.values()) {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      let score = 0;

      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ skill, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.skill);
  }
}
