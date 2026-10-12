/**
 * Yilia abilities (NACAB) — one-shot Chunfeng device controls.
 */
import { NACAB } from '@nyirusu/nasdk';
import { type ChunfengManager } from '../chunfeng/manager.js';
export declare function createYiliaAbilities(manager: ChunfengManager): NACAB;
