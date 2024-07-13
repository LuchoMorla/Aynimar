const { google } = require("googleapis");
const { config } = require("../config/config");
const stream = require("stream");

class FileService {
  constructor() {
    this.#inititalizeOAuth();
  }

  #inititalizeOAuth = async () => {
    this.oAuth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
    this.oAuth2Client.setCredentials({
      refresh_token: config.refreshToken
    })
    const { credentials } = await this.oAuth2Client.refreshAccessToken();
    this.oAuth2Client.setCredentials(credentials);
  }

  async uploadFile(file) {
    const drive = google.drive({ version: 'v3', auth: this.oAuth2Client });
    const bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);

    const response = await drive.files.create({
      resource: {
        name: file.originalname, // Use the original filename for the uploaded file
        mimeType: file.mimetype, // Set the MIME type of the file
      },
      media: {
        mimeType: file.mimetype,
        body: bufferStream, // Use the file stream as the body of the request
      },
    });

    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    })

    return response.data;
  }

}

module.exports = { FileService }