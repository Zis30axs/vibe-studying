# Original PDF test fixtures

No supplied or downloaded textbook appears here. These files contain only
short, self-authored testing sentences, and are not political study materials.

- `knowledge-pdf.ts`: builds minimal real PDFs on demand, with arbitrary
  physical pages and standard CJK font metadata. Used for extraction, limits,
  empty pages, cancellation and hashing tests. Its font is intentionally not
  embedded, so it is not proof of portable Chinese raster rendering.
- `knowledge-encrypted.pdf`: the default original three-page fixture, encrypted
  with pypdf 6.10.0 AES-256 and a synthetic test-only password. Only used to
  verify that password-protected input is rejected without importing anything.
- `knowledge-cjk.pdf`: a one-page original Chinese-only fixture with an embedded
  subset font. The Noto Sans CJK SC outlines came from the installed Debian font,
  were subset to these sentences and converted to TrueType outlines using
  FontTools, and were renamed `ExamCraftFixture`. PyMuPDF wrote the PDF.
  The font's OFL-1.1 copyright and license are in `Noto-font-LICENSE.txt`.
- `knowledge-scan.pdf`: an image-only rendering of that same original Chinese
  page, written with PyMuPDF. There is no text layer or OCR. It verifies that
  reading still works while extraction correctly reports zero searchable pages.

The embedded fixture's five sentences are:

自编政治检索示例

仅用于软件测试，并非教材。

公民参与公共讨论。

依法监督需要核对事实。

物理页码保留原样，不自动推断章节。

No actual textbook chapter/page mapping is claimed. All references tested by
the application are physical, one-based PDF page numbers.
