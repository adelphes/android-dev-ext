/**
 * @typedef {import('./annotation')} Annotation
 * @typedef {import('./type-parameters')} TypeParameters
 * @typedef {import('./token')} Token
 * 
 * Each Modifier is one of
 *   - a token representing a modifier keyword (e.g public, static, etc)
 *   - an Annotation (eg. @Override)
 *   - or a TypeParameters section (eg <T extends Object>)
 * These can typically appear in any order before a declaration
 *
 * @typedef {Token|Annotation|TypeParameters} Modifier
 */

 module.exports = {}
