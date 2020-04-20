const AndroidSocket = require('./androidsocket');

/**
 * Manages a JDWP connection to the device
 * The debugger uses ADB to setup JDWP port forwarding to the device - this class
 * connects to the local forwarding port
 */
class JDWPSocket extends AndroidSocket {
    /**
     * @param {(data)=>*} decode_reply function used for decoding raw JDWP data
     * @param {()=>void} on_disconnect function called when the socket disconnects
     */
    constructor(decode_reply, on_disconnect) {
        super('JDWP')
        this.decode_reply = decode_reply;
        this.on_disconnect = on_disconnect;
        /** @type {Map<*,function>} */
        this.cmds_in_progress = new Map();
        this.cmd_queue = [];
    }

    /**
     * Performs the JDWP handshake and begins reading the socket for JDWP events/replies
     */
    async start() {
        const handshake = 'JDWP-Handshake';
        await this.write_bytes(handshake);
        const handshake_reply = await this.read_bytes(handshake.length, 'latin1');
        if (handshake_reply !== handshake) {
            throw new Error('JDWP handshake failed');
        }
        this.start_jdwp_reply_reader();
        return true;
    }

    /**
     * Continuously reads replies from the JDWP socket. After each reply is read,
     * it's matched up with its corresponding command using the request ID.
     */
    async start_jdwp_reply_reader() {
        for (;;) {
            let data;
            try {
                data = await this.read_bytes('length+data'/* , 'latin1' */)
            } catch (e) {
                // ignore socket closed errors (sent when the debugger disconnects)
                if (!/socket closed/i.test(e.message))
                    throw e;
                if (typeof this.on_disconnect === 'function') {
                    this.on_disconnect();
                }
                return;
            }
            const reply = this.decode_reply(data);
            const on_reply = this.cmds_in_progress.get(reply.command);
            if (on_reply) {
                on_reply(reply);
            }
        }
    }

    /**
     * Send a single command to the device and wait for the reply
     * @param {*} command 
     */
    process_cmd(command) {
        return new Promise(resolve => {
            // add the command to the in-progress set
            this.cmds_in_progress.set(command, reply => {
                // once the command has completed, delete it from in-progress and resolve the promise
                this.cmds_in_progress.delete(command);
                resolve(reply);
            });
            // send the raw command bytes to the device
            this.write_bytes(command.toBuffer());
        });
    }

    /**
     * Drain the queue of JDWP commands waiting to be sent to the device
     */
    async run_cmd_queue() {
        for (;;) {
            if (this.cmd_queue.length === 0) {
                return;
            }
            const { command, resolve, reject } = this.cmd_queue[0];
            const reply = await this.process_cmd(command);
            if (reply.errorcode) {
                class JDWPCommandError extends Error {
                    constructor(reply) {
                        super(`JDWP command failed '${reply.command.name}'. Error ${reply.errorcode}`);
                        this.command = reply.command;
                        this.errorcode = reply.errorcode;
                    }
                }
                reject(new JDWPCommandError(reply));
            } else {
                resolve(reply);
            }
            this.cmd_queue.shift();
        }
    }

    /**
     * Queue a command to be sent to the device and wait for the reply
     * @param {*} command 
     */
    async cmd_and_reply(command) {
        return new Promise((resolve, reject) => {
            const queuelen = this.cmd_queue.push({
                command,
                resolve, reject
            })
            if (queuelen === 1) {
                this.run_cmd_queue();
            }
        })
    }
}

module.exports = JDWPSocket;
