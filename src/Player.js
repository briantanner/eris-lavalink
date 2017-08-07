/**
 * Created by Julian & NoobLance on 25.05.2017.
 */
const Constants = require('eris').Constants;

var EventEmitter;

try {
    EventEmitter = require('eventemitter3');
} catch (err) {
    EventEmitter = require('events').EventEmitter;
}

class Player extends EventEmitter {
    constructor(id, { hostname, guildID, channelID, shard, node }) {
        super();
        this.id = id;
        this.node = node;
        this.hostname = hostname;
        this.guildID = guildID;
        this.channelID = channelID;
        this.timestamp = 0;
        this.ready = false;
        this.playing = false;
        this.shard = shard;
        this.state = {};
        // this.region = region;
        // this.prefix = prefix;
        this.receivedEvents = [];
        this.sendQueue = [];
    }

    checkEventQueue() {
        if (this.sendQueue.length > 0) {
            this.sendEvent(this.sendQueue[0]);
        }
    }

    queueEvent(data) {
        if (this.sendQueue.length > 0) {
            this.sendQueue.push(data);
        } else {
            return this.sendEvent(data);
        }
    }

    async sendEvent(data) {
        this.receivedEvents.push(data);
        this.node.send(data);
        process.nextTick(() => this.checkEventQueue());
    }

    connect(data) {
        this.emit('connect');

        this.queueEvent({
            op: 'connect',
            guildId: data.guildID,
            channelId: data.channelID,
        });

        this.queueEvent({
            op: 'voiceUpdate',
            guildId: data.guildID,
            sessionId: data.sessionID,
            event: data.event,
        });
    }

    async disconnect(msg) {
        console.log('==== DISCONNECTED ====');
        if (msg) {
            console.log(msg);
        }
        this.channelID = null;
        this.updateVoiceState();
        this.emit('disconnect');
    }

    reconnect() {
        // this.shard.sendWS(Constants.GatewayOPCodes.VOICE_STATE_UPDATE, {
        //     guild_id: this.id,
        //     channel_id: this.channelID || null,
        //     self_mute: false,
        //     self_deaf: false,
        // });
    }

    stateUpdate(state) {
        this.state = state;
    }

    play(track, options) {
        let payload = Object.assign({
            op: 'play',
            guildId: this.guildID,
            track: track,
        }, options);

        this.node.send(payload);

        this.playing = true;
        this.timestamp = Date.now();
    }

    stop() {
        if (!this.playing) {
            let data = {
                op: 'stop',
                guildId: this.guildID,
            };

            this.queueEvent(data);
            this.playing = false;
            this.resetTimer();
        } else {
            console.error('already stopped playing');
        }
    }

    setPause(pause) {
        this.node.send({
            op: 'pause',
            guildId: this.guildID,
            pause: pause,
        });
    }

    seek(position) {
        this.node.send({
            op: 'seek',
            guildId: this.guildID,
            position: position,
        });
    }

    setVolume(volume) {
        this.node.send({
            op: 'volume',
            guildId: this.guildID,
            volume: volume,
        });
    }

    onTrackEnd(message) {
        console.log('end');
        console.log(message);
        this.playing = false;
        this.resetTimer();
        this.emit('end');
    }

    onTrackException(message) {
        console.log('exception');
        console.log(message);
        this.emit('error', message);
    }
    onTrackStuck(message) {
        console.log('stuck');
        console.log(message);
        this.emit('stuck', message);
    }

    resetTimer() {
        this.timestamp = 0;
    }

    async switchChannel(channelID, reactive) {
        this.channelID = channelID;
        if (!reactive) {
            this.updateVoiceState();
        }
    }

    getTimestamp() {
        return Date.now() - this.timestamp;
    }

    /**
     * Update the bot's voice state
     * @arg {Boolean} selfMute Whether the bot muted itself or not (audio sending is unaffected)
     * @arg {Boolean} selfDeaf Whether the bot deafened itself or not (audio receiving is unaffected)
     */
    updateVoiceState(selfMute, selfDeaf) {
        if (this.shard.sendWS) {
            this.shard.sendWS(Constants.GatewayOPCodes.VOICE_STATE_UPDATE, {
                guild_id: this.id === 'call' ? null : this.id,
                channel_id: this.channelID || null,
                self_mute: !!selfMute,
                self_deaf: !!selfDeaf,
            });
        }
    }
}

module.exports = Player;
