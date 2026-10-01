# Course data: NA12878 reads around CYP2C19 and CYP2C9

Read-only copies of the data for the pipelines practical. Copy what you need
into your own project folder; never change the originals.

| File | What it is |
| --- | --- |
| `SRR098401_1.fastq`, `SRR098401_2.fastq` | 3,519 pairs of real 76-base Illumina exome reads from sample **NA12878** (run SRR098401, 1000 Genomes), from two regions of chromosome 10 |
| `hg19_CYP2C_slices.fa` (+ `.fai`) | the reference: two slices of the human genome (UCSC hg19) – `human_CYP2C19` = chr10:96,530,001–96,560,000 and `human_CYP2C9` = chr10:96,699,001–96,725,000 |
| `MD5SUMS` | checksums of the four data files: `md5sum -c MD5SUMS` checks your copies are identical |
| `provenance.json` | where the data came from and how it was extracted (URLs, hashes, counts, limitations) |
| `colleague/` | the result of running the same pipeline on another computer, for the chapter on software environments |

Positions in results made with this reference are relative to the slices: add
96,530,000 to a position on `human_CYP2C19`, or 96,699,000 on `human_CYP2C9`,
to get the GRCh37/hg19 chromosome 10 coordinate.

The reads were reconstructed from the public 1000 Genomes exome alignment of
NA12878 (both mates of every pair that overlaps the two regions; nothing was
simulated or filtered by variant). The qualities are the recalibrated values
stored in that alignment. This is exome data, so depth varies a lot, and there
is no truth set: agreement between two pipelines shows that they agree, not
that they are right. No clinical interpretation is part of this dataset.
