class Token {
    /**
     * 
     * @param {number} source_idx 
     * @param {string} text 
     * @param {string} simplified_text 
     * @param {number} simplified_text_idx 
     */
    constructor(source_idx, text, simplified_text, simplified_text_idx) {
        this.source_idx = source_idx;
        this.text = text;
        this.simplified_text = simplified_text;
        this.simplified_text_idx = simplified_text_idx;
    }
}

module.exports = Token;
