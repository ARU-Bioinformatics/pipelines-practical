"""Build the two VCF files the simulated 'black box' AI agent returns (MG.AI_AGENT_FILES).
They are deliberately NOT results of an analysis of the reads; what is wrong with them
is for the students to find (the staff notes list it). Run 2 differs from run 1.
Run:  python3 make_agent_vcfs.py   (then make_ai_script.py, which embeds agent_vcfs.json)"""
import json
import os

# real filtered calls of the pipeline (bcftools 1.10): slice, pos, ref, alt, dp, gt
REAL = [("human_CYP2C19", 5124, "A", "G", 71, "0/1"), ("human_CYP2C19", 11616, "G", "A", 106, "0/1"),
        ("human_CYP2C19", 15888, "A", "G", 6, "0/1"), ("human_CYP2C19", 18316, "T", "C", 5, "0/1"),
        ("human_CYP2C9", 1402, "G", "C", 5, "0/1"), ("human_CYP2C9", 2601, "G", "C", 237, "0/1"),
        ("human_CYP2C9", 3047, "C", "T", 190, "0/1"), ("human_CYP2C9", 3337, "C", "T", 5, "0/1"),
        ("human_CYP2C9", 4491, "C", "A", 5, "0/1"), ("human_CYP2C9", 8890, "T", "C", 12, "0/1"),
        ("human_CYP2C9", 18033, "T", "G", 6, "0/1"), ("human_CYP2C9", 18478, "T", "C", 11, "0/1"),
        ("human_CYP2C9", 20827, "A", "G", 7, "1/1"), ("human_CYP2C9", 22107, "G", "C", 5, "1/1"),
        ("human_CYP2C9", 23059, "C", "A", 6, "1/1")]
# hg19 slice start - 1, and hg19 -> GRCh38 shift in this region (checked with rs4244285,
# rs1799853 and rs12248560 in ClinVar/dbSNP: 1,759,757)
OFFSET = {"human_CYP2C19": 96530000 - 1759757, "human_CYP2C9": 96699000 - 1759757}
RSID = {("human_CYP2C19", 11616): "rs4244285", ("human_CYP2C9", 3047): "rs1799853"}

HEADER = """##fileformat=VCFv4.2
##FILTER=<ID=LowQual,Description="Low quality">
##FILTER=<ID=PASS,Description="All filters passed">
##FORMAT=<ID=AD,Number=R,Type=Integer,Description="Allelic depths for the ref and alt alleles in the order listed">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Approximate read depth (reads with MQ=255 or with bad mates are filtered)">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=PL,Number=G,Type=Integer,Description="Normalized, Phred-scaled likelihoods for genotypes as defined in the VCF specification">
##GATKCommandLine=<ID=HaplotypeCaller,CommandLine="HaplotypeCaller --output NA12878.vcf.gz --intervals chr10:94700000-95000000 --input NA12878.recal.bam --reference Homo_sapiens_assembly38.fasta --dbsnp Homo_sapiens_assembly38.dbsnp138.vcf --standard-min-confidence-threshold-for-calling 30.0",Version="{VERSION}",Date="{DATE}">
##INFO=<ID=AC,Number=A,Type=Integer,Description="Allele count in genotypes, for each ALT allele, in the same order as listed">
##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency, for each ALT allele, in the same order as listed">
##INFO=<ID=AN,Number=1,Type=Integer,Description="Total number of alleles in called genotypes">
##INFO=<ID=DP,Number=1,Type=Integer,Description="Approximate read depth; some reads may have been filtered">
##INFO=<ID=FS,Number=1,Type=Float,Description="Phred-scaled p-value using Fisher's exact test to detect strand bias">
##INFO=<ID=MQ,Number=1,Type=Float,Description="RMS Mapping Quality">
##INFO=<ID=QD,Number=1,Type=Float,Description="Variant Confidence/Quality by Depth">
##INFO=<ID=SOR,Number=1,Type=Float,Description="Symmetric Odds Ratio of 2x2 contingency table to detect strand bias">
##contig=<ID=chr10,length=133797422,assembly=GRCh38>
##reference=file:///references/Homo_sapiens_assembly38.fasta
##source=HaplotypeCaller
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878
"""


def rec(pos, rsid, ref, alt, qual, dp, gt, ad, fs=0.0, sor=0.693):
    ac = 2 if gt == "1/1" else 1
    af = "1.00" if gt == "1/1" else "0.500"
    qd = qual / max(dp, 1)
    pl = f"{int(qual + 28)},{int(dp * 3)},0" if gt == "1/1" else f"{int(qual + 8)},0,{int(ad[0] * 30 + 15)}"
    gq = 99 if dp > 12 else min(99, 20 + dp * 6)
    info = f"AC={ac};AF={af};AN=2;DP={dp};FS={fs:.3f};MQ=60.00;QD={qd:.2f};SOR={sor:.3f}"
    return f"chr10\t{pos}\t{rsid}\t{ref}\t{alt}\t{qual:.2f}\tPASS\t{info}\tGT:AD:DP:GQ:PL\t{gt}:{ad[0]},{ad[1]}:{dp}:{gq}:{pl}"


def build(run):
    rows = []
    if run == 1:
        # CYP2C19*17 lies outside the sequenced region: the reads cannot support it
        rows.append((94761900, rec(94761900, "rs12248560", "C", "T", 1127.64, 41, "0/1", (19, 22), 1.2, 0.81)))
    drop = {1: {15888, 18033}, 2: {15888, 18316, 3337, 18033}}[run]
    for i, (chrom, pos, ref, alt, dp, gt) in enumerate(REAL):
        if pos in drop:
            continue
        p38 = pos + OFFSET[chrom]
        rsid = RSID.get((chrom, pos), ".")
        seed = (pos * 7919 + run * 104729) % 1000 / 1000
        if (chrom, pos) == ("human_CYP2C19", 11616):
            # the headline error: all reads 'alt' in run 1 (1/1), a heterozygote in run 2
            if run == 1:
                rows.append((p38, rec(p38, rsid, ref, alt, 3862.77, 104, "1/1", (0, 104), 0.0, 0.73)))
            else:
                rows.append((p38, rec(p38, rsid, ref, alt, 1876.64, 106, "0/1", (51, 55), 2.1, 0.62)))
            continue
        if gt == "1/1":
            qual = dp * 30.0 + 26.84 + seed * 20
            ad = (0, dp)
        else:
            alt_n = max(2, round(dp * (0.44 + 0.12 * seed)))
            ad = (dp - alt_n, alt_n)
            qual = alt_n * 31.2 + 12.61 + seed * 25
        rows.append((p38, rec(p38, rsid, ref, alt, qual, dp, gt, ad, round(seed * 6, 1), 0.5 + seed)))
    if run == 2:
        # a call that is not in run 1 (and not in the reads)
        rows.append((94955418, rec(94955418, ".", "A", "G", 212.77, 9, "0/1", (4, 5), 3.8, 1.02)))
    rows.sort()
    # the date is filled in by the page when the agent "makes" the file (assistant.js)
    version = "4.5.0.0" if run == 1 else "4.4.0.0"
    head = HEADER.replace("{VERSION}", version)
    return head + "\n".join(r for _, r in rows) + "\n", len(rows)


out = {}
for run in (1, 2):
    text, n = build(run)
    out[f"run{run}"] = text
    print(f"run {run}: {n} records")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_vcfs.json"), "w").write(json.dumps(out))
print(out["run1"].split("#CHROM")[1][:1500])
