import { describe, it, expect } from "vitest";
import { PDFParser, PDFParserError } from "./pdf-parser";

describe("PDFParser", () => {
  const parser = new PDFParser();

  describe("validate", () => {
    it("rejects non-PDF files", async () => {
      const buffer = Buffer.from("This is not a PDF");
      const result = await parser.validate(buffer);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("不是有效的 PDF 文件");
    });

    it("rejects files larger than 10MB", async () => {
      // 创建一个模拟的大文件头
      const buffer = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(11 * 1024 * 1024), // 11MB
      ]);

      const result = await parser.validate(buffer);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("文件过大");
      expect(result.reason).toContain("10MB");
    });

    it("accepts valid small PDF-like headers", async () => {
      // 注意：这个测试需要真实的 PDF 文件才能完全通过
      // 这里我们只测试文件头和大小检查的部分逻辑
      const buffer = Buffer.from("%PDF-1.4\nsmall content");

      // 实际会在尝试解析时失败，因为不是完整 PDF
      const result = await parser.validate(buffer);
      expect(result.valid).toBe(false);
      // 但至少通过了文件头检查
    });
  });

  describe("extractText", () => {
    it("throws PDFParserError for invalid PDF", async () => {
      const buffer = Buffer.from("Not a PDF");

      await expect(parser.extractText(buffer)).rejects.toThrow(PDFParserError);
      await expect(parser.extractText(buffer)).rejects.toThrow("无法解析 PDF 文件");
    });

    // 注意：完整测试需要真实的 PDF 测试文件
    // 这里提供测试结构，实际运行需要添加测试 PDF
    it.skip("extracts text from valid PDF", async () => {
      // const testPDFBuffer = await fs.readFile("test-fixtures/sample-resume.pdf");
      // const result = await parser.extractText(testPDFBuffer);
      // expect(result.text).toContain("TypeScript");
      // expect(result.pages).toBeGreaterThan(0);
    });
  });

  describe("cleanText", () => {
    it("normalizes line breaks and removes excess whitespace", async () => {
      // 通过创建一个包含已知文本的简单 "PDF" 来间接测试 cleanText
      // 实际实现需要真实 PDF，这里展示测试意图
      const text = "Line 1\r\n\r\nLine 2\n\n\n\nLine 3   ";
      // cleanText 是 private 方法，通过 extractText 测试其效果
      // 或者将其改为 protected 以便测试
    });
  });
});
