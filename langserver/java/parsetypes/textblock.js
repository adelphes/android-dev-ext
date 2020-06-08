class BlockRange {

    get end() { return this.start + this.length }
    get text() { return this.source.slice(this.start, this.end) }
    /**
     * 
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     */
    constructor(source, start, length) {
        this.source = source;
        this.start = start;
        this.length = length;
    }
}

class TextBlock {
    /**
     * @param {BlockRange|TextBlockArray} range
     * @param {string} simplified
     */
    constructor(range, simplified) {
        this.range = range;
        this.simplified = simplified;
    }

    blockArray() {
        return this.range instanceof TextBlockArray ? this.range : null;
    }

    /**
     * Returns the length of the original source
     * @returns {number}
     */
    get length() {
        return this.range.length;
    }

    /**
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     * @param {string} [simplified] 
     */
    static from(source, start, length, simplified) {
        const range = new BlockRange(source, start, length);
        return new TextBlock(range, simplified || range.text);
    }

    get source() { return this.toSource() }

    /**
     * @returns {string}
     */
    toSource() {
        return this.range instanceof BlockRange
            ? this.range.text
            : this.range.toSource()
    }
}

class TextBlockArray {
    /**
     * @param {string} id
     * @param {import('../tokenizer').Token[]} [blocks] 
     */
    constructor(id, blocks = []) {
        this.id = id;
        this.blocks = blocks;
    }

    /**
     * Returns the length of the original source
     * @returns {number}
     */
    get length() {
        return this.blocks.reduce(((len,b) => len + b.length), 0);
    }

    get simplified() {
        return this.blocks.map(tb => tb.simplified).join('');
    }

    /** @returns {number} */
    get start() {
        return this.blocks[0].range.start;
    }

    sourcemap() {
        let idx = 0;
        const parts = [];
        /** @type {number[]} */
        const map = this.blocks.reduce((arr,tb,i) => {
            arr[idx] = i;
            if (!tb) {
                throw this.blocks;
            }
            parts.push(tb.simplified);
            idx += tb.simplified.length;
            return arr;
        }, []);
        map[idx] = this.blocks.length;
        return {
            simplified: parts.join(''),
            map,
        }
    }

    /**
     * @param {string} id
     * @param {number} start_block_idx 
     * @param {number} block_count 
     * @param {RegExpMatchArray} match
     * @param {string} marker 
     * @param {*} [parseClass] 
     * @param {boolean} [pad] 
     */
    shrink(id, start_block_idx, block_count, match, marker, parseClass, pad=true) {
        if (block_count <= 0) return;
        const collapsed = new TextBlockArray(id, this.blocks.splice(start_block_idx, block_count, null));
        const simplified = pad 
            ? collapsed.source.replace(/./g, ' ').replace(/^./, marker)
            : marker;
        return this.blocks[start_block_idx] = parseClass
            ? new parseClass(collapsed, simplified, match)
            : new TextBlock(collapsed, simplified);
    }

    get source() { return this.toSource() }

    toSource() {
        return this.blocks.map(tb => tb.toSource()).join('');
    }
}

module.exports = {
    BlockRange,
    TextBlock,
    TextBlockArray,
}
