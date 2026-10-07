#!/usr/bin/env python3
"""The day of the year in the C library's localtime() and mktime(), as the JavaScript loader of a program computes it.

Emscripten's loader worked the day of the year (tm_yday) out from the milliseconds that have passed since
1 January, local time. In a zone with summer time that is one hour short in summer: for a local time between
00:00 and 00:59 on a summer day the result was the day before. GNU date then refused such dates
("date -d 2024-07-15" printed "invalid date" in the UK and in Europe), and %j could be a day out.

The change: the day of the year is the number of days between the two calendar dates.

    fix-day-of-year.py FILE.js …          make the change (a file that has it already is left alone)
    fix-day-of-year.py --check FILE.js …  say whether each file has it
"""
import sys

OLD = 'var yday=(date.getTime()-start.getTime())/(1e3*60*60*24)|0;'
NEW = 'var yday=Math.round((Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())-Date.UTC(date.getFullYear(),0,1))/864e5);'

def main(argv):
    check = argv[:1] == ['--check']
    files = argv[1:] if check else argv
    if not files:
        print(__doc__)
        return 2
    status = 0
    for path in files:
        text = open(path, encoding='utf-8').read()
        old, new = text.count(OLD), text.count(NEW)
        if check:
            print(f'{path}: {"changed" if new and not old else "not changed" if old else "no such code"} ({old} old, {new} new)')
            status = status or (0 if new and not old else 1)
            continue
        if not old:
            print(f'{path}: nothing to change ({new} places have the new code)')
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(OLD, NEW))
        print(f'{path}: {old} place(s) changed')
    return status

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
