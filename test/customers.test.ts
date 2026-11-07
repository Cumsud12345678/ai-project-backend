import test from "node:test";
import assert from "node:assert/strict";
import { buildCustomers, contactKey } from "../src/customers.js";
import type { LiveChat } from "../src/store/types.js";

const chat = (p: Partial<LiveChat>): LiveChat => ({ id: "c", tenantId: "t", tokenHash: "", name: "", contact: "", status: "closed", context: [], messages: [], createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"), ...p });

test("müştəri kartı: eyni telefon (fərqli yazılış) və kanal ID-si bir kartda birləşir", () => {
  assert.equal(contactKey("+994 50 123 45 67"), contactKey("050-123-45-67"));
  assert.equal(contactKey("Ali@Mail.az"), "e:ali@mail.az");
  const list = buildCustomers({ blocked: [{ key: "wa:994501234567", label: "x", at: new Date(), by: "b" }] }, [
    chat({ id: "a", name: "Ali", contact: "+994 50 123 45 67", channel: { type: "whatsapp", chatId: "994501234567" }, messages: [{ from: "visitor", text: "salam", at: new Date() }], tags: ["vip"] }),
    chat({ id: "b", contact: "", channel: { type: "whatsapp", chatId: "994501234567" }, createdAt: new Date("2026-11-05"), updatedAt: new Date("2026-11-05") }),
    chat({ id: "c2", name: "Vəli", contact: "veli@mail.az" }),
  ], [{ id: "l1", at: "2026-11-06T00:00:00.000Z", name: "", contact: "050 123 45 67", question: "kredit?", status: "pending" }]);
  assert.equal(list.length, 2);
  const ali = list.find((c) => c.name === "Ali")!;
  assert.deepEqual(ali.chats.map((c) => c.id), ["b", "a"]);
  assert.equal(ali.leads[0]!.status, "pending");
  assert.deepEqual(ali.channels.sort(), ["form", "whatsapp"]);
  assert.equal(ali.blocked, true);
  assert.equal(ali.lastAt, "2026-11-06T00:00:00.000Z");
  assert.equal(buildCustomers({}, [chat({ id: "x", name: "Vəli", contact: "veli@mail.az" })], [], "ali").length, 0);
});
