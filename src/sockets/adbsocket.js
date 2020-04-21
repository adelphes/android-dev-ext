const AndroidSocket = require('./androidsocket');


/**
 * Manages a socket connection to Android Debug Bridge
 */
class ADBSocket extends AndroidSocket {

    /**
     * The port number to run ADB on.
     * The value can be overriden by the adbPort value in each configuration.
     */
    static ADBPort = 5037;

    constructor() {
        super('ADBSocket');
    }

    /**
     * Reads and checks the reply from an ADB command
     * @param {boolean} [throw_on_fail] true if the function should throw on non-OKAY status
     */
    async read_adb_status(throw_on_fail = true) {
        // read back the status
        const status = await this.read_bytes(4, 'latin1')
        if (status !== 'OKAY' && throw_on_fail) {
            throw new Error(`ADB command failed. Status: '${status}'`);
        }
        return status;
    }

    /**
     * Reads and decodes an ADB reply. The reply is always in the form XXXXnnnn where XXXX is a 4 digit ascii hex length
     */
    async read_adb_reply() {
        const hexlen = await this.read_bytes(4, 'latin1');
        if (/[^\da-fA-F]/.test(hexlen)) {
            throw new Error('Bad ADB reply - invalid length data');
        }
        return this.read_bytes(parseInt(hexlen, 16), 'latin1');
    }

    /**
     * Writes a command to the ADB socket
     * @param {string} command 
     */
    write_adb_command(command) {
        const command_bytes = Buffer.from(command);
        const command_length = Buffer.from(('000' + command_bytes.byteLength.toString(16)).slice(-4));
        return this.write_bytes(Buffer.concat([command_length, command_bytes]));
    }

    /**
     * Sends an ADB command and checks the returned status
     * @param {String} command ADB command to send
     * @returns {Promise<string>} OKAY status or rejected
     */
    async cmd_and_status(command) {
        await this.write_adb_command(command);
        return this.read_adb_status();
    }

    /**
     * Sends an ADB command, checks the returned status and then reads the return reply
     * @param {String} command ADB command to send
     * @returns {Promise<string>} reply string or rejected if the status is not OKAY
     */
    async cmd_and_reply(command) {
        await this.cmd_and_status(command);
        return this.read_adb_reply();
    }

    /**
     * Sends an ADB command, checks the returned status and then reads raw data from the socket
     * @param {string} command 
     * @param {number} timeout_ms
     */
    async cmd_and_read_stdout(command, timeout_ms) {
        await this.cmd_and_status(command);
        return this.read_stdout('latin1', timeout_ms);
    }

    /**
     * Copies a file to the device, setting the file time and permissions
     * @param {ADBFileTransferParams} file file parameters
     */
    async transfer_file(file) {
        await this.cmd_and_status('sync:');

        // initiate the file send
        const filename_and_perms = `${file.pathname},${file.perms}`;
        const send_and_fileinfo = Buffer.from(`SEND\0\0\0\0${filename_and_perms}`);
        send_and_fileinfo.writeUInt32LE(filename_and_perms.length, 4);
        await this.write_bytes(send_and_fileinfo);

        // send the file data
        await this.write_file_data(file.data);

        // send the DONE message with the new filetime
        const done_and_mtime = Buffer.from('DONE\0\0\0\0');
        done_and_mtime.writeUInt32LE(file.mtime, 4);
        await this.write_bytes(done_and_mtime);

        // read the final status and any error message
        const result = await this.read_adb_status(false);
        const failmsg = await this.read_le_length_data('latin1');
        
        // finish the transfer mode
        await this.write_bytes('QUIT\0\0\0\0');

        if (result !== 'OKAY') {
            throw new Error(`File transfer failed. ${failmsg}`);
        }
        return true;
    }

    /**
     * @param {Buffer} data 
     */
    async write_file_data(data) {
        const dtinfo = {
            transferred: 0,
            transferring: 0,
            chunk_size: 10240,
        };

        for (;;) {
            dtinfo.transferred += dtinfo.transferring;
            const remaining = data.byteLength - dtinfo.transferred;
            if (remaining <= 0 || isNaN(remaining)) {
                return dtinfo.transferred;
            }
            const datalen = Math.min(remaining, dtinfo.chunk_size);

            const cmd = Buffer.concat([Buffer.from(`DATA\0\0\0\0`), data.slice(dtinfo.transferred, dtinfo.transferred + datalen)]);
            cmd.writeUInt32LE(datalen, 4);

            dtinfo.transferring = datalen;
            await this.write_bytes(cmd);
        }
    }
}

module.exports = ADBSocket;
