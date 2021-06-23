import { freeze } from "./freeze";
import { transportForChannel } from "./transport-for-channel";
import { authorizeOrSanitizeMessage } from "./utils/permissions-utils";

export default class PhoenixAdapter {
  constructor() {
    this.refs = new Map();
    this.occupants = []; // TODO: Remove
    // TODO: Maybe keep frozen messages somewhere else.
    // TODO: ORRRRRR get rid of freezing
    this.frozenUpdates = new Map();
    this._blockedClients = new Map();
  }
  setServerUrl() {}
  setApp() {}
  setRoom() {}
  setWebRtcOptions() {}
  setServerConnectListeners(nafConnectSuccess, nafConnectFailed) {
    this.nafConnectSuccess = nafConnectSuccess;
    this.nafConnectFailed = nafConnectFailed;
  }
  setRoomOccupantListener() {}
  setDataChannelListeners(nafOccupantJoined, nafOccupantLeave, nafMessageReceived) {
    this.nafOccupantJoined = nafOccupantJoined;
    this.nafOccupantLeave = nafOccupantLeave;
    this.nafMessageReceived = nafMessageReceived;
  }
  async connect() {
    if (!this.hubChannel || !this.session_id || !this.events) {
      this.nafConnectFailed("Uh oh!");
      return;
    }
    this.refs.set("naf", this.hubChannel.channel.on("naf", this.handleIncomingNAF));
    this.refs.set("nafr", this.hubChannel.channel.on("nafr", this.handleIncomingNAFR));

    this.nafConnectSuccess(this.session_id);
    this.reliableTransport = transportForChannel(this.hubChannel.channel, true);
    this.unreliableTransport = transportForChannel(this.hubChannel.channel, false);

    this.hubChannel.presence.list().forEach(this.onOccupantJoin);
    this.refs.set("hub:join", this.events.on(`hub:join`, this.onOccupantJoin));
    this.refs.set("hub:leave", this.events.on(`hub:leave`, this.onOccupantLeft));
  }
  shouldStartConnectionTo() {}
  startStreamConnection() {}
  closeStreamConnection() {}
  getConnectStatus() {}

  getMediaStream() {
    return Promise.reject("getMediaStream not implemented in phoenix-adapter");
  }

  getServerTime() {
    // TODO: Account for latency to server
    return Date.now();
  }

  sendData(clientId, dataType, data) {
    this.unreliableTransport(clientId, dataType, data);
  }
  sendDataGuaranteed(clientId, dataType, data) {
    this.reliableTransport(clientId, dataType, data);
  }
  broadcastData(dataType, data) {
    this.unreliableTransport(undefined, dataType, data);
  }
  broadcastDataGuaranteed(dataType, data) {
    this.reliableTransport(undefined, dataType, data);
  }

  disconnect() {
    this.events.off("naf", this.refs.get("naf"));
    this.events.off("nafr", this.refs.get("nafr"));
    this.events.off("hub:join", this.refs.get("hub:join"));
    this.events.off("hub:leave", this.refs.get("hub:leave"));
    this.refs.delete("naf");
    this.refs.delete("nafr");
    this.refs.delete("hub:join");
    this.refs.delete("hub:leave");
  }

  toggleFreeze() {
    if (this.frozen) {
      this.unfreeze();
    } else {
      this.freeze();
    }
  }

  freeze() {
    this.frozen = true;
  }

  unfreeze() {
    this.frozen = false;
    this.flushPendingUpdates();
  }

  flushPendingUpdates() {
    for (const [networkId, message] of this.frozenUpdates) {
      const data = this.getPendingData(networkId, message);
      if (!data) continue;

      // Override the data type on "um" messages types, since we extract entity updates from "um" messages into
      // individual frozenUpdates in storeSingleMessage.
      const dataType = message.dataType === "um" ? "u" : message.dataType;

      this.nafMessageReceived(null, dataType, data, message.source);
    }
    this.frozenUpdates.clear();
  }

  getPendingData(networkId, message) {
    if (!message) return null;

    const data = message.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, message) : message.data;

    // Ignore messages from users that we may have blocked while frozen.
    if (data.owner && this._blockedClients.has(data.owner)) return null;

    return data;
  }

  // Used externally
  getPendingDataForNetworkId(networkId) {
    return this.getPendingData(networkId, this.frozenUpdates.get(networkId));
  }

  handleIncomingNAF = data => {
    const message = authorizeOrSanitizeMessage(data);
    const source = "phx-reliable";
    if (!message.dataType) return;

    message.source = source;

    //TODO: Handle frozen
    if (this.frozen) {
      this.storeMessage(message);
    } else {
      this.nafMessageReceived(null, message.dataType, message.data, message.source);
    }
  };
  handleIncomingNAFR = ({ from_session_id, naf: unparsedData }) => {
    // Server optimization: server passes through unparsed NAF message, we must now parse it.
    const data = JSON.parse(unparsedData);
    data.from_session_id = from_session_id;
    this.handleIncomingNAF(data);
  };

  onOccupantJoin = ({ key, meta }) => {
    this.occupants.push(key);
    this.nafOccupantJoined(key);
  };
  onOccupantLeft = ({ key, meta }) => {
    this.occupants.slice(this.occupants.indexOf(key), 1);
    this.nafOccupantLeave(key);
  };
  storeMessage(message) {
    if (message.dataType === "um") {
      // UpdateMulti
      for (let i = 0, l = message.data.d.length; i < l; i++) {
        this.storeSingleMessage(message, i);
      }
    } else {
      this.storeSingleMessage(message);
    }
  }

  storeSingleMessage(message, index) {
    const data = index !== undefined ? message.data.d[index] : message.data;
    const dataType = message.dataType;

    const networkId = data.networkId;

    if (!this.frozenUpdates.has(networkId)) {
      this.frozenUpdates.set(networkId, message);
    } else {
      const storedMessage = this.frozenUpdates.get(networkId);
      const storedData =
        storedMessage.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, storedMessage) : storedMessage.data;

      // Avoid updating components if the entity data received did not come from the current owner.
      const isOutdatedMessage = data.lastOwnerTime < storedData.lastOwnerTime;
      const isContemporaneousMessage = data.lastOwnerTime === storedData.lastOwnerTime;
      if (isOutdatedMessage || (isContemporaneousMessage && storedData.owner > data.owner)) {
        return;
      }

      if (dataType === "r") {
        const createdWhileFrozen = storedData && storedData.isFirstSync;
        if (createdWhileFrozen) {
          // If the entity was created and deleted while frozen, don't bother conveying anything to the consumer.
          this.frozenUpdates.delete(networkId);
        } else {
          // Delete messages override any other messages for this entity
          this.frozenUpdates.set(networkId, message);
        }
      } else {
        // merge in component updates
        if (storedData.components && data.components) {
          Object.assign(storedData.components, data.components);
        }
      }
    }
  }
  dataForUpdateMultiMessage(networkId, message) {
    // "d" is an array of entity datas, where each item in the array represents a unique entity and contains
    // metadata for the entity, and an array of components that have been updated on the entity.
    // This method finds the data corresponding to the given networkId.
    for (let i = 0, l = message.data.d.length; i < l; i++) {
      const data = message.data.d[i];

      if (data.networkId === networkId) {
        return data;
      }
    }

    return null;
  }

  onData() {
    //TODO: Remove
  }
  setClientId() {
    //TODO: Remove
  }
  setJoinToken() {
    //TODO: Remove
  }
  setServerParams() {
    //TODO: Remove
  }
  setReconnectionListeners() {
    //TODO: Remove
  }
  setTurnConfig() {
    //TODO: Remove
  }
  setLocalMediaStream() {
    //TODO: Remove
  }
  enableMicrophone() {
    //TODO: Remove
  }
  syncOccupants() {
    //TODO: Remove
  }
  on() {
    //TODO: Remove
  }
  off() {
    //TODO: Remove
  }
}

NAF.adapters.register("phoenix", PhoenixAdapter);
