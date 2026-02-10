import { google } from "googleapis";
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
export async function uploadJsonReport(name, json) {
    const auth = await google.auth.getClient({
        scopes: ["https://www.googleapis.com/auth/drive.file"]
    });
    const drive = google.drive({ version: "v3", auth });
    const fileMetadata = { name, parents: folderId ? [folderId] : undefined };
    const media = { mimeType: "application/json", body: Buffer.from(JSON.stringify(json, null, 2)) };
    const res = await drive.files.create({ requestBody: fileMetadata, media });
    return { fileId: res.data.id, name: res.data.name };
}
