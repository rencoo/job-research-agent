import * as pdfParse from "pdf-parse";

export interface PDFParseResult {
  text: string;
  pages: number;
  metadata: {
    title?: string;
    author?: string;
    creator?: string;
  };
}

export class PDFParser {
  /**
   * 从 PDF Buffer 中提取文本
   */
  async extractText(buffer: Buffer): Promise<PDFParseResult> {
    try {
      const data = await (pdfParse as any).default(buffer, {
        // 限制最大页数，避免处理过大文件
        max: 20,
      });

      return {
        text: this.cleanText(data.text),
        pages: data.numpages,
        metadata: {
          title: data.info?.Title,
          author: data.info?.Author,
          creator: data.info?.Creator,
        },
      };
    } catch (error) {
      throw new PDFParserError(
        "pdf_parse_failed",
        `无法解析 PDF 文件: ${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }

  /**
   * 清理提取的文本
   * - 规范化换行
   * - 移除过多的空白
   * - 保留有意义的格式
   */
  private cleanText(text: string): string {
    return (
      text
        // 规范化换行
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        // 移除页眉页脚常见模式（页码等）
        .replace(/^\d+\s*$/gm, "")
        // 合并多余空行（保留最多2个连续换行）
        .replace(/\n{3,}/g, "\n\n")
        // 移除行首行尾空白
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        // 移除开头和结尾的空行
        .trim()
    );
  }

  /**
   * 验证 PDF 文件有效性
   */
  async validate(buffer: Buffer): Promise<{ valid: boolean; reason?: string }> {
    // 检查 PDF 文件头
    const header = buffer.subarray(0, 5).toString("utf-8");
    if (!header.startsWith("%PDF-")) {
      return { valid: false, reason: "不是有效的 PDF 文件" };
    }

    // 检查文件大小（限制 10MB）
    const maxSize = 10 * 1024 * 1024;
    if (buffer.length > maxSize) {
      return {
        valid: false,
        reason: `文件过大（${Math.round(buffer.length / 1024 / 1024)}MB），最大支持 10MB`,
      };
    }

    // 尝试解析以确保文件可读
    try {
      await this.extractText(buffer);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof PDFParserError ? error.message : "PDF 文件损坏或加密",
      };
    }
  }
}

export class PDFParserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PDFParserError";
  }
}
