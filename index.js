export class BusHub {
  constructor(state, env) {
    this.state = state;
    this.driver = null;
    this.viewers = [];
    this.lastLocation = null;
    this.missedBookings = [];
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request, url.searchParams.get("role"));
    }

    if (url.pathname.endsWith("/notify")) {
      return this.handleBookingNotify(request);
    }

    return new Response("BusHub OK", { status: 200 });
  }

  handleWebSocket(request, role) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    if (role === "driver") {
      this.driver = server;

      if (this.missedBookings.length > 0) {
        this.missedBookings.forEach(b => server.send(JSON.stringify(b)));
        this.missedBookings = [];
      }

      server.send(JSON.stringify({
        type: "viewer_count",
        count: this.viewers.length
      }));

      server.addEventListener("close", () => { 
        this.driver = null; 
      });

      server.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "location") {
          this.lastLocation = { ...data, timestamp: Date.now() };
          this.broadcastToViewers(this.lastLocation);
        }
      });

    } else {
      this.viewers.push(server);

      if (this.lastLocation) {
        server.send(JSON.stringify(this.lastLocation));
      }

      this.updateDriverViewerCount();

      server.addEventListener("close", () => {
        this.viewers = this.viewers.filter(s => s !== server);
        this.updateDriverViewerCount();
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleBookingNotify(request) {
    const booking = await request.json();

    if (this.driver) {
      try {
        this.driver.send(JSON.stringify(booking));
      } catch (e) {
        this.missedBookings.push(booking);
        this.driver = null;
      }
    } else {
      this.missedBookings.push(booking);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  broadcastToViewers(data) {
    const dead = [];
    this.viewers.forEach((ws, i) => {
      try { ws.send(JSON.stringify(data)); }
      catch (e) { dead.push(i); }
    });
    dead.reverse().forEach(i => this.viewers.splice(i, 1));
  }

  updateDriverViewerCount() {
    if (this.driver) {
      try {
        this.driver.send(JSON.stringify({
          type: "viewer_count",
          count: this.viewers.length
        }));
      } catch (e) { 
        this.driver = null; 
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname.startsWith("/driver/")) {
      const busId = decodeURIComponent(url.pathname.split("/driver/")[1]);
      const hub = env.BUS_HUB.get(env.BUS_HUB.idFromName(busId));
      const newUrl = new URL(request.url);
      newUrl.searchParams.set("role", "driver");
      return hub.fetch(new Request(newUrl.toString(), request));
    }

    if (url.pathname.startsWith("/track/")) {
      const busId = decodeURIComponent(url.pathname.split("/track/")[1]);
      const hub = env.BUS_HUB.get(env.BUS_HUB.idFromName(busId));
      const newUrl = new URL(request.url);
      newUrl.searchParams.set("role", "passenger");
      return hub.fetch(new Request(newUrl.toString(), request));
    }

    if (url.pathname === "/webhook/orders" && request.method === "POST") {
      return handleShopifyWebhook(request, env);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Vehicle Notification Worker v1.0", { status: 200 });
  }
};

async function handleShopifyWebhook(request, env) {
  try {
    const order = await request.json();
    const busId = order.line_items?.[0]?.product_title;
    const passengerName = order.note_attributes?.find(
      a => a.name === "passenger_name"
    )?.value ?? "Unknown Passenger";
    const coordinates = order.note_attributes?.find(
      a => a.name === "coordinates"
    )?.value ?? null;
    const variant = order.line_items?.[0]?.variant_title ?? "N/A";
    const seats = order.line_items?.[0]?.quantity ?? 1;

    if (!busId) return new Response("No bus ID", { status: 400 });

    const notification = {
      type: "new_passenger",
      busId,
      passengerName,
      coordinates,
      variant,
      seats,
      orderId: order.id,
      orderNumber: order.order_number,
      timestamp: Date.now(),
      createdAt: new Date().toISOString()
    };

    const hub = env.BUS_HUB.get(env.BUS_HUB.idFromName(busId));
    const notifyUrl = new URL("/notify", "http://internal");
    await hub.fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notification)
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
