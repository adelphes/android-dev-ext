const net = require('net');
const EventEmitter = require('events');

/**
 * Common socket class for ADBSocket and JDWPSocket
 */
class AndroidSocket extends EventEmitter {
    constructor(which) {
        super()
        this.which = which;
        this.socket = null;
        this.socket_error = null;
        this.socket_ended = false;
        this.readbuffer = Buffer.alloc(0);
    }

    connect(port, hostname) {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                return reject(new Error(`${this.which} Socket connect failed. Socket already connected.`));
            }
            const connection_error = err => {
                return reject(new Error(`${this.which} Socket connect failed. ${err.message}.`));
            }
            const post_connection_error = err => {
                this.socket_error = err;
                this.socket.end();
            }
            let error_handler = connection_error;
            this.socket = new net.Socket()
                .once('connect', () => {
                    error_handler = post_connection_error;
                    this.socket
                        .on('data', buffer => {
                            this.readbuffer = Buffer.concat([this.readbuffer, buffer]);
                            this.emit('data-changed');
                        })
                        .once('end', () => {
                            this.socket_ended = true;
                            this.emit('socket-ended');
                            if (!this.socket_disconnecting) {
                                this.socket_disconnecting = this.socket_error ? Promise.reject(this.socket_error) : Promise.resolve();
                            }
                        });
                    resolve();
                })
                .on('error', err => error_handler(err));
            this.socket.connect(port, hostname);
        });
    }

    disconnect() {
        if (!this.socket_disconnecting) {
            this.socket_disconnecting = new Promise(resolve => {
                this.socket.end();
                this.socket = null;
                this.once('socket-ended', resolve);
            });
        }
        return this.socket_disconnecting;
    }

    /**
     * 
     * @param {number|'length+data'|undefined} length 
     * @param {string} [format] 
     */
    async read_bytes(length, format) {
        //D(`reading ${length} bytes`);
        let actual_length = length;
        if (typeof actual_length === 'undefined') {
            if (this.readbuffer.byteLength > 0 || this.socket_ended) {
                actual_length = this.readbuffer.byteLength;
            }
        }
        if (actual_length < 0) {
            throw new Error(`${this.which} socket read failed. Attempt to read ${actual_length} bytes.`);
        }
        if (length === 'length+data' && this.readbuffer.byteLength >= 4) {
            length = actual_length = this.readbuffer.readUInt32BE(0);
        }
        if (this.socket_ended) {
            if (actual_length <= 0 || (this.readbuffer.byteLength < actual_length)) {
                this.check_socket_active('read');
            }
        }
        // do we have enough data in the buffer?
        if (this.readbuffer.byteLength >= actual_length) {
            //D(`got ${actual_length} bytes`);
            let data = this.readbuffer.slice(0, actual_length);
            this.readbuffer = this.readbuffer.slice(actual_length);
            if (format) {
                data = data.toString(format);
            }
            return Promise.resolve(data);
        }
        // wait for the socket to update and then retry the read
        await this.wait_for_socket_data();
        return this.read_bytes(length, format);
    }

    wait_for_socket_data() {
        return new Promise((resolve, reject) => {
            let done = 0;
            let onDataChanged = () => {
                if ((done += 1) !== 1) return;
                this.off('socket-ended', onSocketEnded);
                resolve();
            }
            let onSocketEnded = () => {
                if ((done += 1) !== 1) return;
                this.off('data-changed', onDataChanged);
                reject(new Error(`${this.which} socket read failed. Socket closed.`));
            }
            this.once('data-changed', onDataChanged);
            this.once('socket-ended', onSocketEnded);
        });
    }

    async read_le_length_data(format) {
        const len = await this.read_bytes(4);
        return this.read_bytes(len.readUInt32LE(0), format);
    }

    read_stdout(format = 'latin1') {
        return this.read_bytes(undefined, format);
    }

    /**
     * Writes a raw command to the socket
     * @param {string|Buffer} bytes 
     */
    write_bytes(bytes) {
        return new Promise((resolve, reject) => {
            this.check_socket_active('write');
            try {
                const flushed = this.socket.write(bytes, () => {
                    flushed ? resolve() : this.socket.once('drain', resolve);
                });
            } catch (e) {
                this.socket_error = e;
                reject(new Error(`${this.which} socket write failed. ${e.message}`));
            }
        });
    }

    /**
     * 
     * @param {'read'|'write'} action 
     */
    check_socket_active(action) {
        if (this.socket_ended) {
            throw new Error(`${this.which} socket ${action} failed. Socket closed.`);
        }

    }
}

module.exports = AndroidSocket;
