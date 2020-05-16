/**
 * @typedef {import('./import')} ImportDeclaration
 */

 /**
  * Class representing a resolved import.
  * 
  * Each instance holds an array of types that would be resolved by the specified import.
  * Each type is mapped to an MTI which lists the implementation details of the type (fields, methods, etc).
  * 
  */
 class ResolvedImport {
    /**
     * @param {ImportDeclaration} import_decl 
     * @param {RegExpMatchArray} matches 
     * @param {'owner-package'|'import'|'implicit-import'} import_kind;
     */
    constructor(import_decl, matches, typemap, import_kind) {
        /**
         * The associated import declaration.
         * - this value is null for owner-package and implicit-imports
         */
        this.import = import_decl;

        /**
         * Array of fully qualified type names in JRE format resolved in this import
         */
        this.fullyQualifiedNames = Array.from(matches);

        /**
         * THe map of fully-qualified type names to MTIs
         */
        this.types = new Map(matches.map(name => [name, typemap.get(name)]));

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
