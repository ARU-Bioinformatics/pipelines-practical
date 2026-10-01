# A second run of the same pipeline

These files come from running the practical's pipeline – the same rules,
the same `config/config.yaml` and the same input data as yours, with the
variant-calling rules in a conda environment – on a Linux computer (not in
a web browser), with

    snakemake --cores 1 --use-conda

(Snakemake 9.27.0, conda 26.7.3). The environment file for the variant
calling rules asked for:

    channels:
      - conda-forge
      - bioconda
    dependencies:
      - bcftools=1.10

| File | What it is |
| --- | --- |
| `NA12878.filtered.vcf.gz` | the filtered variant calls made by that run |
| `calling-environment.yml` | `conda env export` of the environment conda built for the calling rules (folder names shortened) |

Compare them with your own results in the chapter on software environments.
