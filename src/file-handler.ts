import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Logger } from "./logger";
import { config } from "./config";
export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  size: number;
}

export class FileHandler {
  private logger = new Logger("FileHandler");
  private slackApp: any;

  constructor(slackApp?: any) {
    this.slackApp = slackApp;
  }

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        } else {
          this.logger.warn(`File processing returned null for ${file.name}`, {
            name: file.name,
            size: file.size,
            mimetype: file.mimetype,
          });
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, {
          error: error instanceof Error ? error.message : String(error),
          name: file.name,
          size: file.size,
          mimetype: file.mimetype,
        });
      }
    }

    return processedFiles;
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn("File too large, skipping", {
        name: file.name,
        size: file.size,
      });
      return null;
    }

    try {
      let buffer: Buffer;

      // The key issue: Slack file URLs often redirect to HTML login pages
      // Solution: Download directly through Slack's Web API client
      if (this.slackApp && this.slackApp.client) {
        try {
          // Use Slack's Web API client which handles authentication properly
          const result = await this.slackApp.client.files.info({
            file: file.id,
          });

          if (!result.ok) {
            throw new Error(`Slack API error: ${result.error}`);
          }

          // Get the file URL that should work with our token
          const downloadUrl =
            result.file.url_private_download || result.file.url_private;

          // Download using the authenticated URL with proper headers
          const response = await (globalThis as any).fetch(downloadUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.slack.botToken}`,
              "User-Agent": "SlackBot/1.0",
              Accept: "*/*",
            },
            redirect: "follow", // Allow redirects but maintain auth headers
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          // Verify we got actual file content, not HTML
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            this.logger.error("Still receiving HTML instead of file", {
              fileName: file.name,
              contentType: contentType,
              responseUrl: response.url,
            });
            throw new Error(`Received HTML page instead of file content`);
          }

          buffer = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          this.logger.error("Slack Web API file download failed", {
            error: error instanceof Error ? error.message : String(error),
            fileName: file.name,
            fileId: file.id,
          });
          throw error;
        }
      } else {
        this.logger.error("No Slack app client available for file download", {
          fileName: file.name,
          hasSlackApp: !!this.slackApp,
          hasClient: !!(this.slackApp && this.slackApp.client),
        });
        throw new Error("Slack Web API client required for file downloads");
      }
      const tempDir = os.tmpdir();
      const tempPath = path.join(
        tempDir,
        `slack-file-${Date.now()}-${file.name}`,
      );

      fs.writeFileSync(tempPath, buffer);

      const processed: ProcessedFile = {
        path: tempPath,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
      };

      return processed;
    } catch (error) {
      this.logger.error("Failed to download file", {
        error: error instanceof Error ? error.message : String(error),
        fileName: file.name,
        fileSize: file.size,
        mimetype: file.mimetype,
        url: file.url_private_download,
      });
      return null;
    }
  }

  /**
   * Format files into a prompt string for Claude
   * All files are passed by path - Claude Code will use its Read tool to access content
   * @param files - Array of processed files to format
   * @returns Formatted string with file information
   */
  formatFilesOnly(files: ProcessedFile[]): string {
    if (files.length === 0) {
      return "";
    }

    const parts: string[] = files.map(
      file =>
        `- **${file.name}** (${file.mimetype}, ${file.size} bytes): \`${file.path}\``,
    );

    return (
      "The following files have been uploaded. Use the Read tool to access their contents:\n" +
      parts.join("\n")
    );
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        this.logger.warn("Failed to cleanup temp file", {
          path: file.path,
          error,
        });
      }
    }
  }
}
