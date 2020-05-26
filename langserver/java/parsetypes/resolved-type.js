/**
 * @typedef {import('./token')} Token
 * @typedef {import('./type')} TypeDeclaration
 * @typedef {import('java-mti').JavaType} JavaType
 */

/**
 * Class representing a parsed and resolved type
 * 
 * Each `ResolvedType` consists of a linked set of parsed `TypeParts` and an array dimensions count.
 * Each `TypePart` is a single dotted type with optional type arguments.
 * 
 * When parsing, the first type part matches all dotted idents up to the first type with arguments - after
 * that, there is a single type part for each further enclosed type.
 * 
 * Examples:
 * 
 *   int -> one TypePart, arrdims = 0
 *   int[][] -> one TypePart, arrdims = 2
 *   List<String> -> one type part with one typeargs entry
 *   List<String>.InnerType -> two type parts (List<String> / InnerType)
 *   List<String>.InnerType.AnotherInner -> three type parts (List<String> / InnerType / AnotherInner)
 *   java.util.List<String>.InnerType<Object>.AnotherInner -> three type parts (java.util.List<String> / InnerType<Object> / AnotherInner)
 *   java.util.List.InnerType.AnotherInner -> one type part
 * 
 * The reason for the non-obvious splitting is that the first part of the type could incorporate a package name - we
 * cannot tell which parts of the name are packages and which are types/enclosed types until we try to resolve it.
 * But type arguments are only allowed on types, so any qualifiers that appear after type arguments can only be a type and
 * so we split on each single identifier.
 *
 */
class ResolvedType {

    static TypePart = class TypePart {
        /**
         * The list of type arguments
         * @type {ResolvedType[]}
         */
        typeargs = null;

        /**
         * The outer type if this is an enclosed generic type
         * @type {ResolvedType.TypePart}
         */
        outer = null;
        inner = null;

        /**
         * @param {ResolvedType} owner
         * @param {string} name
         * @param {ResolvedType.TypePart} outer
         */
        constructor(owner, name, outer) {
            this.owner = owner;
            this.name = name;
            this.outer = outer;
        }

        get label() {
            return this.name + (this.typeargs ? `<${this.typeargs.map(arg => arg.label).join(',')}>` : '');
        }

        get rawlabel() {
            return this.name;
        }
    }

    /** @type {ResolvedType.TypePart[]} */
    parts = [];

    /**
     * number of array dimensions for this type
     */
    arrdims = 0;

    /**
     * Error reason if parsing failed.
     */
    error = '';

    /**
     * The resolved JavaTypes that match this type. This will be an empty array if the type cannot be found.
     * @type {JavaType[]}
     */
    mtis = [];

    /**
     * @param {boolean} [isTypeArg] 
     */
    constructor(isTypeArg = false) {
        this.isTypeArg = isTypeArg;
    }

    /**
     * During parsing, add a new type part
     * @param {string} [name] 
     * @param {ResolvedType.TypePart} [outer] 
     */
    addTypePart(name = '', outer = null) {
        const p = new ResolvedType.TypePart(this, name, outer);
        this.parts.push(p);
        return p;
    }

    getDottedRawType() {
        // most types will only have one part
        if (this.parts.length === 1)
            return this.parts[0].name;
        return this.parts.map(p => p.name).join('.');
    }

    get isPrimitive() {
        if (this.arrdims > 0 || this.parts.length !== 1) {
            return false;
        }
        return /^(int|boolean|char|void|byte|long|double|float|short)$/.test(this.parts[0].name);
    }

    get label() {
        return this.parts.map(p => p.label).join('.') + '[]'.repeat(this.arrdims);
    }

    get rawlabel() {
        return this.parts.map(p => p.rawlabel).join('.') + '[]'.repeat(this.arrdims);
    }
};

module.exports = ResolvedType;
