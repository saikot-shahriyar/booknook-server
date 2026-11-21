import { config } from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import dns from "node:dns";

config({ path: ".env" });
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const orphanBookIds = [
    "6b01e6bff8301e62e123e07e", "6b01e6bff8301e62e123e07f",
    "6b01e6bff8301e62e123e080", "6b01e6bff8301e62e123e081",
];
const orphanUserIds = ["6b01e6bcda7c8fb35ac6a71f", "6b01e6bdda7c8fb35ac6a722"];

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db("booknook");
const ids = orphanBookIds.map((i) => new ObjectId(i));
const bRes = await db.collection("books").deleteMany({ _id: { $in: ids } });
console.log("orphan books deleted:", bRes.deletedCount);
const borrowRes = await db.collection("borrows").deleteMany({ bookId: { $in: orphanBookIds } });
console.log("orphan borrows deleted:", borrowRes.deletedCount);
const uRes = await db.collection("user").deleteMany({ _id: { $in: orphanUserIds.map((i) => new ObjectId(i)) } });
console.log("orphan users deleted:", uRes.deletedCount);
console.log("session docs deleted:", (await db.collection("session").deleteMany({ userId: { $in: orphanUserIds } })).deletedCount);
console.log("account docs deleted:", (await db.collection("account").deleteMany({ userId: { $in: orphanUserIds } })).deletedCount);
await c.close();
