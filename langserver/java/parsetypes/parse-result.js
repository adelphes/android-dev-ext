/**
 * @typedef {import('./import')} ImportDeclaration
 * @typedef {import('./package')} PackageDeclaration
 * @typedef {import('./parse-error')} ParseSyntaxError
 * @typedef {import('./type')} TypeDeclaration
 */

 class ParseResult {
    /**
     * 
     * @param {PackageDeclaration} package_decl 
     * @param {ImportDeclaration[]} imports 
     * @param {TypeDeclaration[]} types 
     * @param {ParseSyntaxError[]} invalids
     */
    constructor(package_decl, imports, types, invalids) {
        this.package = package_decl;
        this.imports = imports;
        this.types = types;
        this.invalids = invalids;
    }
}

module.exports = ParseResult;
