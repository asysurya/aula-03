// Setup akun S3 MinIO lokal + bucket + CORS utk uji kecepatan presigned.
// Jalankan dari /home/z/aula-03 (butuh @aws-sdk dari node_modules).
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { MongoClient } = require("mongodb");

const ENDPOINT = "http://127.0.0.1:9000";
const BUCKET = "aula-test";
const ACCESS = "aulatest";
const SECRET = "aulatest12345";

async function main() {
  const client = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    // MinIO/R2 tidak dukung checksum CRC32 default SDK v3.729+.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  // Buat bucket bila belum ada.
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log("bucket sudah ada:", BUCKET);
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log("bucket dibuat:", BUCKET);
  }

  // CORS: MinIO lokal sudah mengirim header CORS lengkap secara default
  // (Access-Control-Allow-Origin echo + expose Content-Range/ETag/Length —
  // terverifikasi). PutBucketCors justru ditolak MinIO (checksum SDK), skip.

  // Simpan CloudAccount aktif di DB.
  const mongo = await MongoClient.connect(
    "mongodb://127.0.0.1:27777/aula-test?directConnection=true"
  );
  const db = mongo.db("aula-test");
  const existing = await db.collection("CloudAccount").findOne({ provider: "s3" });
  const doc = {
    provider: "s3",
    label: "MinIO Lokal",
    endpoint: ENDPOINT,
    region: "auto",
    bucket: BUCKET,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    active: true,
    fileCount: 0,
    lastStatus: "connected",
    updatedAt: new Date(),
    createdAt: new Date(),
  };
  if (existing) {
    await db.collection("CloudAccount").updateOne(
      { _id: existing._id },
      { $set: { ...doc, createdAt: existing.createdAt } }
    );
    console.log("CloudAccount s3 diupdate:", existing._id.toString());
  } else {
    const r = await db.collection("CloudAccount").insertOne(doc);
    console.log("CloudAccount s3 dibuat:", r.insertedId.toString());
  }
  await mongo.close();
}

main().catch((e) => {
  console.error("GAGAL:", e.message);
  process.exit(1);
});
