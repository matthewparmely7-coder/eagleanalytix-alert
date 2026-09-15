const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

let sharedClient;
function client() {
    if (!sharedClient) sharedClient = new S3Client({
        region: (process.env.AWS_ACCESS_REGION || "").replace(/['"]/g, "").trim(),
        credentials: {
            accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").replace(/['"]/g, "").trim(),
            secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").replace(/['"]/g, "").trim()
        }
    });
    return sharedClient;
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        stream.on("error", reject);
    });
}

async function readTicketInfo(fileName, folderName, signal) {
    const bucket = (process.env.AWS_BUCKET_TICKETSHISTORY || "tickets-history").replace(/['"]/g, "").trim();
    try {
        const { Body } = await client().send(
            new GetObjectCommand({
                Bucket: bucket,
                Key: `${folderName}/${fileName}`
            }),
            { abortSignal: signal }
        );
        return JSON.parse(await streamToString(Body));
    } catch (err) {
        const code = err.Code || err.name || "";
        if (code !== "NoSuchKey" && code !== "NotFound") {
            throw err;
        }
        return [];
    }
}

module.exports = { readTicketInfo };
