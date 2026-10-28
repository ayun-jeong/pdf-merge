# PDF 합치기

PDF와 사진을 순서대로 모아 한 PDF로 만들고, 제각각인 페이지 크기를 하나로 맞추는 사이트.
**https://ayun-jeong.github.io/pdf-merge/**

- 파일은 브라우저 안에서만 열고 합친다 (서버 없음, 업로드 없음, 분석 도구 없음).
- PDF 페이지는 벡터 그대로 복사 → 글자 선택·검색, 링크, 형광펜·메모가 유지된다. 채워진 양식은 보이는 그대로 페이지에 굳힌다.
- 비밀번호·권한 보호 PDF, pdf-lib가 못 읽는 PDF는 PDF.js로 200dpi 그림을 그려 넣는다 (파일 목록에 "그림으로 들어감" 표시).
- 사진(JPG·PNG는 원본 그대로, WebP·GIF 등은 PNG로) 한 장이 한 페이지. JPG의 EXIF 회전을 따른다.

## 크기 맞추기

- 페이지 크기: A4·B5·A3·A5·B4·Letter·Legal, 첫 페이지와 같게, 가장 많은 크기로, 직접 입력(mm), 크기 그대로 두기
- 방향: 자동(가로로 긴 페이지는 가로 용지) / 세로 / 가로
- 맞추는 방법: 전체 보이게(비율 유지, 여백 생김) / 꽉 채우기(넘치는 가장자리 잘림)
- 여백 0–30mm, 작은 페이지 키우기 여부
- 페이지 카드의 미리보기는 `assets/layout.js`의 같은 계산을 쓰므로 결과 PDF와 똑같이 보인다.

## 구조

빌드 없는 정적 사이트. `index.html` + `assets/`(app.js 화면, layout.js 크기 계산, merge.js PDF 만들기) + `vendor/`(라이브러리 복사본).

```sh
npm install
npm run vendor        # node_modules → vendor/ 복사 (버전 바꿀 때만)
python3 -m http.server 8791   # http://127.0.0.1:8791/
```

## 테스트

```sh
python tests/make_fixtures.py <dir>          # 크기·회전·CropBox·양식·암호·EXIF 사진 등 (pymupdf, pillow 필요)
node tests/e2e.mjs <url> <out> '{"size":"A4","fit":"fill","margin":10}' <files...>   # 로컬 Chrome으로 합치기
python tests/check_output.py <out>/합본.pdf   # 쪽마다 크기·회전·글자·링크·색 샘플
```

라이브러리: pdf-lib (MIT), PDF.js (Apache-2.0), SortableJS (MIT) — `vendor/licenses/`.
