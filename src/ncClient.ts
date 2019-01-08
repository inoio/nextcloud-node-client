// tslint:disable-next-line:no-var-requires
const debug = require("debug").debug("NCFlient");

import path from "path";
import NCError from "./ncError";
import NCFile from "./ncFile";
import NCFolder from "./ncFolder";

export {
    NCClient,
    NCError,
    NCFolder,
    NCFile
};

export default class NCClient {

    public static getCredentials(): { username: string, password: string, url: string } {
        let credentials:
            {
                "url": string;
                "username": string;
                "password": string;
            };

        if (process.env.NODE_ENV === "development") {
            credentials = require("./../userProvidedService.json");

        } else {
            if (!process.env.VCAP_SERVICES) {
                throw new NCError("NCClient getCredentials VCAP_SERVICES not found", "ERR_VCAP_SERVICES_NOT_FOUND");
            }
            let vcapServices: any;
            try {
                vcapServices = JSON.parse(process.env.VCAP_SERVICES);
            } catch (e) {
                throw new NCError("NCClient getCredentials VCAP_SERVICES not valid JSON",
                    "ERR_VCAP_SERVICES_INVALID",
                    { vcapServices: process.env.VCAP_SERVICES });
            }

            if (vcapServices["user-provided"] && vcapServices["user-provided"][0]) {
                if (!vcapServices["user-provided"][0].url) {
                    throw new NCError("NCClient getCredentials VCAP_SERVICES url not defined in user provided services for nextcloud"
                        , "ERR_VCAP_SERVICES_URL_NOT_DEFINED",
                        { vcapServices: process.env.VCAP_SERVICES });

                }
                if (!vcapServices["user-provided"][0].username) {
                    throw new NCError("NCClient getCredentials VCAP_SERVICES username not defined in user provided services for nextcloud",
                        "ERR_VCAP_SERVICES_USERNAME_NOT_DEFINED",
                        { vcapServices: process.env.VCAP_SERVICES });

                }
                if (!vcapServices["user-provided"][0].password) {
                    throw new NCError("NCClient getCredentials VCAP_SERVICES password not defined in user provided services for nextcloud",
                        "ERR_VCAP_SERVICES_PASSWORD_NOT_DEFINED",
                        { vcapServices: process.env.VCAP_SERVICES });

                }

                credentials = vcapServices["user-provided"][0];
            } else {
                throw new NCError("NCClient getCredentials user provided services not found",
                    "ERR_USER_PROVIDED_SERVICES_NOT_FOUND");

            }
        }
        return credentials;
    }

    /**
     * create a new instance of a nextcloud client
     */
    public static async clientFactory(): Promise<NCClient> {
        const credentials:
            {
                "url": string;
                "username": string;
                "password": string;
            } = NCClient.getCredentials();

        const client: NCClient = new NCClient(credentials.url, credentials.username, credentials.password);

        // ensure that the client is working
        await client.getQuota();
        return client;
    }

    private webDAVClient: any;

    /**
     * the constructor is private - the factory method should be used to get instances
     * @param webDavUrl the url endpoint of the nextcloud WebDAV server
     * @param username basic auth username
     * @param password basic auth password
     */
    private constructor(webDavUrl: string, username: string, password: string) {
        debug("constructor");
        const { createClient } = require("webdav");
        this.webDAVClient = createClient(webDavUrl, { username, password });
        // debug("webdav client %O", this.client);
    }

    public async getQuota() {
        debug("getQuota");
        const q = await this.webDAVClient.getQuota();
        debug("getQuota = %O", q);
        return q;
    }

    /**
     * creates a folder and all parent folders in the path if they do not exist
     * @param folderName name of the folder /folder/subfolder/subfolder
     * @returns a folder object
     */
    public async createFolder(folderName: string): Promise<NCFolder> {
        folderName = this.sanitizeFolderName(folderName);
        debug("createFolder: folderName=%s", folderName);

        let folder: NCFolder | null;

        folder = await this.getFolder(folderName);
        if (folder) {
            debug("createFolder: folder already available %O", folder.name);
            return folder;
        } else {
            // try to do a simple create with the complete path
            try {
                debug("createFolder: folder = %s", folderName);
                await this.webDAVClient.createDirectory(folderName);
            } catch (e) {
                // create all folders in the path
                const parts: string[] = folderName.split("/");
                parts.shift();
                let folderPath: string = "";
                debug("createFolder: parts = %O", parts);

                for (const part of parts) {
                    debug("createFolder: part = %O", part);
                    folderPath += "/" + part;
                    folder = await this.getFolder(folderPath);

                    if (folder === null) {
                        debug("createFolder: folder not available");
                        // folder not  available
                        try {
                            debug("createFolder: folder = %s", folderPath);
                            const d = await this.webDAVClient.createDirectory(folderPath);
                        } catch (e) {
                            debug("createFolder: exception occurred calling webDAV client createDirectory %O", e.message);
                            throw e;
                        }
                    } else {
                        debug("createFolder: folder already available %s", folderPath);
                    }
                }
            }
        }

        folder = await this.getFolder(folderName);
        if (folder) {
            debug("createFolder: new folder %O", folder.name);
            return folder;
        } else {
            throw new Error("createFolder: Error creating folder " + folderName);
        }

    }

    /**
     * deletes a file
     * @param fileName name of folder "/f1/f2/f3/x.txt"
     */
    public async deleteFile(fileName: string): Promise<void> {
        debug("deleteFile");
        let response: any;

        try {
            response = await this.webDAVClient.deleteFile(fileName);
            if (response.status && response.status === 204) {
                debug("deleteFile: ok");
            } else {
                throw new Error("Error deleting file or folder " + fileName);
            }
        } catch (e) {
            debug("deleteFile: exception occurred %O", e);
            throw e;
        }
    }

    /**
     * deletes a folder
     * @param folderName name of folder "/f1/f2/f3"
     */
    public async deleteFolder(folderName: string): Promise<void> {
        folderName = this.sanitizeFolderName(folderName);
        debug("deleteFolder:");

        const folder: NCFolder | null = await this.getFolder(folderName);

        if (folder) {
            await this.deleteFile(folderName);
        }
    }

    /**
     * get a folder object from a path string
     * @param folderName Name of the folder like "/company/branches/germany"
     * @returns null if the folder does not exist or an folder object
     */
    public async getFolder(folderName: string): Promise<NCFolder | null> {
        folderName = this.sanitizeFolderName(folderName);

        // return root folder
        if (folderName === "/") {
            return new NCFolder(this, "/", "", "");
        }

        debug("getFolder folderName=%s", folderName);

        const parts: string[] = folderName.split("/");
        let folderPath: string = "";

        debug("getFolder: parts = %O", parts);

        for (const part of parts) {
            debug("getFolder:part = %O", part);
            let folderContentsArray;
            folderPath += "/" + part;
            try {
                folderContentsArray = await this.webDAVClient.getDirectoryContents(folderPath);
                for (const folderElement of folderContentsArray) {
                    if (folderElement.type === "directory") {
                        debug("getFolder:folder element %s", folderElement.filename);
                        if (folderElement.filename === folderName) {
                            debug("getFolder: SUCCESS!!");
                            return new NCFolder(this,
                                folderElement.filename.replace(/\\/g, "/"),
                                folderElement.basename,
                                folderElement.lastmod);
                        }
                    }
                }
            } catch (e) {
                debug("getFolder: exception occurred calling getFolderContents %O", e.message);
                return null;
            }
        }

        return null;
    }

    /**
     * get a array of folders from a folder path string
     * @param folderName Name of the folder like "/company/branches/germany"
     * @returns array of folder objects
     */
    public async getSubFolders(folderName: string): Promise<NCFolder[]> {
        debug("getSubFolders: folder %s", folderName);
        const folders: NCFolder[] = [];
        folderName = this.sanitizeFolderName(folderName);

        const folderElements: any[] = await this.getFolderContents(folderName, true);

        for (const folderElement of folderElements) {
            debug("getSubFolders: adding subfolders %s", folderElement.filename);
            folders.push(new NCFolder(this,
                folderElement.filename.replace(/\\/g, "/"),
                folderElement.basename,
                folderElement.lastmod));
        }

        return folders;
    }

    /**
     * get files of a folder
     * @param folderName Name of the folder like "/company/branches/germany"
     * @returns array of file objects
     */
    public async getFiles(folderName: string): Promise<NCFile[]> {
        debug("getFiles: folder %s", folderName);
        const files: NCFile[] = [];
        folderName = this.sanitizeFolderName(folderName);

        const fileElements: any[] = await this.getFolderContents(folderName, false);

        for (const folderElement of fileElements) {
            debug("getFiles: adding file %s", folderElement.filename);
            // debug("getFiles: adding file %O", folderElement);
            files.push(new NCFile(this,
                folderElement.filename.replace(/\\/g, "/"),
                folderElement.basename,
                folderElement.lastmod,
                folderElement.size,
                folderElement.mime));
        }

        return files;
    }

    /**
     * create a new file of overwrites an existing file
     * @param fileName the file name /folder1/folder2/filename.txt
     * @param data the buffer object
     */
    public async createFile(fileName: string, data: Buffer): Promise<NCFile | null> {

        const baseName: string = path.basename(fileName);
        let folderName: string = path.dirname(fileName);
        if (folderName === ".") {
            folderName = "";
        }
        debug("createFile folder name %s base name %s", folderName, baseName);

        // ensure that we have the folder
        let folder: NCFolder | null;

        try {
            folder = await this.createFolder(folderName);
        } catch (e) {
            e.message = "Error creating file: " + e.message;
            throw e;
        }
        if (folder === null) {
            throw new NCError("File could not be created: Folder '" + folderName + "' could not be created",
                "ERR_FOLDER_NOT_FOUND",
                { folderName, baseName });
        }

        // fileName = "/d1/d2/file.txt"
        const res = await this.webDAVClient.putFileContents(fileName, data, { format: "binary" });
        // debug("%O", Object.keys(res));
        debug("createFile Status %s", res.status);

        if (!(res.status === "204" || res.status !== "201")) {
            throw new NCError("File could not be created: '" + fileName + "', response status " + res.status + " " + res.statusText,
                "ERR_FILE_CREATE_FAILED",
                { folderName, baseName });
        }
        debug("createFile file successfully created");

        return await this.getFile(fileName);
    }

    /**
     * returns a nextcloud file object
     * @param fileName the full file name /folder1/folder2/file.pdf
     */
    public async getFile(fileName: string): Promise<NCFile | null> {
        debug("getFile fileName = %s", fileName);
        const client = this;
        let folderContentsArray;

        try {
            folderContentsArray = await this.webDAVClient.getDirectoryContents(path.dirname(fileName));
            for (const folderElement of folderContentsArray) {
                // debug("getFile element %O", folderElement);
                if (folderElement.type === "file") {
                    if (folderElement.filename === fileName) {
                        return new NCFile(client,
                            folderElement.filename.replace(/\\/g, "/"),
                            folderElement.basename,
                            folderElement.lastmod,
                            folderElement.size,
                            folderElement.mime);
                    }
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    /**
     * renames the file or moves it to an other location
     * @param sourceFileName source file name
     * @param targetFileName target file name
     */
    public async moveFile(sourceFileName: string, targetFileName: string): Promise<NCFile> {
        debug("moveFile from '%s' to '%s'", sourceFileName, targetFileName);
        let res: any;
        try {
            res = await this.webDAVClient.moveFile(sourceFileName, targetFileName);
        } catch (e) {
            debug("moveFile exception occurred %s", e.message);
            throw new NCError("Error: moving file failed: source=" + sourceFileName + " target=" + targetFileName + " - " + e.message, "ERR_FILE_MOVE_FAILED");
        }

        const targetFile: NCFile | null = await this.getFile(targetFileName);
        if (!targetFile) {
            throw new NCError("Error: moving file failed: source=" + sourceFileName + " target=" + targetFileName, "ERR_FILE_MOVE_FAILED");
        }

        return targetFile;
    }

    /**
     * renames the folder or moves it to an other location
     * @param sourceFolderName source folder name
     * @param targetFolderName target folder name
     */
    public async moveFolder(sourceFolderName: string, targetFolderName: string): Promise<NCFolder> {
        debug("moveFolder from '%s' to '%s'", sourceFolderName, targetFolderName);
        let res: any;
        try {
            res = await this.webDAVClient.moveFile(sourceFolderName, targetFolderName);
        } catch (e) {
            debug("moveFolder exception occurred %s", e.message);
            throw new NCError("Error: moving folder failed: source=" + sourceFolderName + " target=" + targetFolderName + " - " + e.message, "ERR_FOLDER_MOVE_FAILED");
        }

        const targetFolder: NCFolder | null = await this.getFolder(targetFolderName);
        if (!targetFolder) {
            throw new NCError("Error: moving folder failed: source=" + sourceFolderName + " target=" + targetFolderName, "ERR_FOLDER_MOVE_FAILED");
        }

        return targetFolder;
    }

    /**
     * returns the content of a file
     * @param fileName name of the file /d1/file1.txt
     * @returns Buffer with file content
     */
    public async getContent(fileName: string): Promise<Buffer> {
        const content: Buffer = await this.webDAVClient.getFileContents(fileName);
        return content;
    }

    /**
     * returns the link to a file for downloading
     * @param fileName name of the file /folder1/folder1.txt
     * @returns url
     */
    public getLink(fileName: string): string {
        debug("getLink of %s", fileName);
        let link: string = this.webDAVClient.getFileDownloadLink(fileName);
        if (link.indexOf("@") > -1) {
            // remove basic auth info from link
            if (link.startsWith("https")) {
                link = "https://" + link.substring(link.indexOf("@") + 1);
            } else {
                link = "http://" + link.substring(link.indexOf("@") + 1);
            }
        }
        return link;
    }

    /**
     * get contents array of a folder
     * @param folderName Name of the folder like "/company/branches/germany"
     * @param folderIndicator true if folders are requested otherwise files
     * @returns array of folder contents meta data
     */
    private async getFolderContents(folderName: string, folderIndicator: boolean): Promise<any[]> {
        debug("getFolderContents: folder %s", folderName);
        const folders: NCFolder[] = [];
        folderName = this.sanitizeFolderName(folderName);
        const resultArray: any[] = [];

        if (folderIndicator === true) {
            debug("getFolderContents: get folders");
        } else {
            debug("getFolderContents: get files");
        }
        try {
            const folderContentsArray = await this.webDAVClient.getDirectoryContents(folderName);

            for (const folderElement of folderContentsArray) {
                if (folderElement.type === "directory") {
                    if (folderIndicator === true) {
                        resultArray.push(folderElement);
                    }
                } else {
                    if (folderIndicator === false) {
                        debug("getFolderContents folder element file %O ", folderElement);
                        resultArray.push(folderElement);
                    }
                }
            }
        } catch (e) {
            debug("getFolderContents: exception occurred %s", e.message);
        }

        return resultArray;
    }

    private sanitizeFolderName(folderName: string): string {
        if (folderName[0] !== "/") {
            folderName = "/" + folderName;
        }
        // remove trailing "/" es
        folderName = folderName.replace(/\/+$/, "");
        if (folderName === "") {
            folderName = "/";
        }

        return folderName;
    }

}
