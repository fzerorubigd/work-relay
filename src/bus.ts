import mqtt, { MqttClient } from "mqtt";
import { Config } from "./config.js";
import { Envelope, filterIncoming } from "./envelope.js";

export type IncomingHandler = (envelope: Envelope, topic: string) => void;

export class Bus {
  private client: MqttClient | null = null;
  private subscribedRooms = new Set<string>();
  private handler: IncomingHandler | null = null;

  constructor(private readonly config: Config) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Persistent sessions need a stable client_id (no random suffix) and
      // clean: false so the broker remembers subscriptions across reconnects
      // and queues messages for offline agents. Default ephemeral path keeps
      // the random suffix for backward compatibility.
      const clientId = this.config.persistent
        ? `work-relay-${this.config.agentId}`
        : `work-relay-${this.config.agentId}-${Math.random().toString(36).slice(2, 8)}`;
      const client = mqtt.connect(this.config.brokerUrl, {
        username: this.config.brokerUser,
        password: this.config.brokerPass,
        clientId,
        clean: !this.config.persistent,
        reconnectPeriod: 5000,
      });

      client.on("connect", () => {
        this.client = client;
        const directTopic = `bus/agents/${this.config.agentId}`;
        const broadcastTopic = `bus/agents/broadcast`;
        // QoS 1 so the broker queues messages for persistent-session agents
        // that are offline; ephemeral clients still get them live.
        client.subscribe([directTopic, broadcastTopic], { qos: 1 }, (err) => {
          if (err) return reject(err);
          for (const room of this.config.initialRooms) {
            this.subscribeRoom(room).catch(() => {
              /* logged elsewhere */
            });
          }
          resolve();
        });
      });

      client.on("error", (err) => {
        if (!this.client) reject(err);
      });

      client.on("message", (topic, payload) => {
        this.dispatch(topic, payload);
      });
    });
  }

  onMessage(handler: IncomingHandler): void {
    this.handler = handler;
  }

  private dispatch(topic: string, payload: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf-8"));
    } catch {
      return;
    }
    const envelope = filterIncoming(parsed);
    if (!envelope) return;
    this.handler?.(envelope, topic);
  }

  async publishDirect(envelope: Envelope): Promise<void> {
    if (!this.client) throw new Error("not connected");
    const topic =
      envelope.to === "*" ? "bus/agents/broadcast" : `bus/agents/${envelope.to}`;
    await this.publish(topic, envelope);
  }

  async publishGroup(room: string, envelope: Envelope): Promise<void> {
    if (!this.client) throw new Error("not connected");
    await this.publish(`bus/agents/groups/${room}`, envelope);
  }

  async subscribeRoom(room: string): Promise<void> {
    if (!this.client) throw new Error("not connected");
    if (this.subscribedRooms.has(room)) return;
    await new Promise<void>((resolve, reject) => {
      this.client!.subscribe(`bus/agents/groups/${room}`, { qos: 1 }, (err) => {
        if (err) return reject(err);
        this.subscribedRooms.add(room);
        resolve();
      });
    });
  }

  async leaveRoom(room: string): Promise<void> {
    if (!this.client) throw new Error("not connected");
    if (!this.subscribedRooms.has(room)) return;
    await new Promise<void>((resolve, reject) => {
      this.client!.unsubscribe(`bus/agents/groups/${room}`, (err) => {
        if (err) return reject(err);
        this.subscribedRooms.delete(room);
        resolve();
      });
    });
  }

  rooms(): string[] {
    return [...this.subscribedRooms];
  }

  private publish(topic: string, envelope: Envelope): Promise<void> {
    return new Promise((resolve, reject) => {
      // QoS 1 so brokers can queue messages for offline persistent-session
      // subscribers (e.g. workers using `fetch_messages`). Ephemeral
      // subscribers receive QoS 1 messages live the same way.
      this.client!.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    return new Promise((resolve) => {
      this.client!.end(false, {}, () => resolve());
    });
  }
}
