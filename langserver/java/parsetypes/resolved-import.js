/**
 * @typedef {import('java-mti').CEIType} CEIType
 */

 /**
  * Class representing a resolved import.
  * 
  * Each instance holds an array of types that would be resolved by the specified import.
  * Each type is mapped to a JavaType which lists the implementation details of the type (fields, methods, etc).
  * 
  */
 class ResolvedImport {
    /**
     * @param {RegExpMatchArray} matches 
     * @param {string} static_ident
     * @param {Map<string,CEIType>} typemap
     * @param {'owner-package'|'import'|'implicit-import'} import_kind
     */
    constructor(matches, static_ident, typemap, import_kind) {
        /**
         * Array of fully qualified type names in JRE format resolved in this import
         */
        this.fullyQualifiedNames = Array.from(matches);

        /**
         * THe map of fully-qualified type names to JavaTypes
         */
        this.types = new Map(matches.map(name => [name, typemap.get(name)]));

        this.members = [];
        if (static_ident) {
            const type = typemap.get(matches[0]);
            if (type) {
                type.fields.forEach(f => f.modifiers.includes('static') && (static_ident === '*' || static_ident === f.name) && this.members.push(f));
                type.methods.forEach(m => m.modifiers.includes('static') && (static_ident === '*' || static_ident === m.name) && this.members.push(m));
            }
        }

        /**
         * What kind of import this is:
         *   - `"owner-package"`: types that are implicitly imported from the same package as the declared module
         *   - `"import"`: types that are inclduded via an import declaration specified in the module
         *   - `"implicit-import"`: types that are included without any explicit import (`java.lang.*` for example)
         */
        this.import_kind = import_kind;
    }
}

module.exports = ResolvedImport;
