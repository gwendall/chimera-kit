# The evaluation corpus

`en.tsv` has one sentence per line: `id`, `kind`, `split`, `text`. `generate.py` rebuilds it, and
it is committed so that every run scores the same sentences. Changing it changes what a score
means: bump `JUDGE_VERSION` in `../run.ts` and record new baselines.

| kind      | what                                                                                             | why                                                                       |
| --------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `harvard` | Harvard sentences                                                                                | ordinary phonetically balanced speech                                     |
| `sus`     | semantically unpredictable sentences, generated from a seed after Benoit, Grice and Hazan (1996) | grammatical nonsense, so a recognizer can't guess a word from its context |

Each split has 60 sentences of each kind. Harvard lists 1 to 60 were used to tune the upstream
engine, so the held and locked splits come from lists 61 to 72, which were not. Every word of the
unpredictable sentences is in the pronouncing dictionary, so they test articulation, not
spelling rules.

## Licenses

The Harvard sentences are from the IEEE Recommended Practice for Speech Quality Measurements
(1969). This copy of them was taken from the TSP speech database, which is under this license:

> Copyright (c) 2018 Peter Kabal
> All rights reserved.
>
> Redistribution and use in source and binary forms, with or without modification, are
> permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of
>    conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of
>    conditions and the following disclaimer in the documentation and/or other materials
>    provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
> IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
> AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
> CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
> THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
> OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.
