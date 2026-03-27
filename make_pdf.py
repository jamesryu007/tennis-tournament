#!/usr/bin/env python3
"""GitHub Pages 배포 가이드 PDF 생성"""

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, PageBreak
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus.flowables import Flowable
import reportlab.rl_config

# ── 폰트 등록 ──────────────────────────────────────────────────────────────
FONT_PATH = '/System/Library/Fonts/Supplemental/AppleGothic.ttf'
pdfmetrics.registerFont(TTFont('KR', FONT_PATH))

MONO = 'Courier'

# ── 컬러 팔레트 ────────────────────────────────────────────────────────────
C_NAVY    = colors.HexColor('#0d1f35')
C_BLUE    = colors.HexColor('#1a5a9a')
C_BLUE2   = colors.HexColor('#2a7ac0')
C_LBLUE   = colors.HexColor('#deeef8')
C_TEAL    = colors.HexColor('#0e7a6a')
C_TEAL_BG = colors.HexColor('#e2f5f2')
C_ORANGE  = colors.HexColor('#d05010')
C_AMBER   = colors.HexColor('#a06000')
C_AMBER_BG= colors.HexColor('#fff8e8')
C_CODE_BG = colors.HexColor('#1a2a3a')
C_CODE_FG = colors.HexColor('#7fdbff')
C_GRAY    = colors.HexColor('#5a6a7a')
C_LGRAY   = colors.HexColor('#f0f4f8')
C_WHITE   = colors.white
C_BLACK   = colors.HexColor('#1a2030')
C_GREEN   = colors.HexColor('#1a7a4a')
C_GREEN_BG= colors.HexColor('#e6f5ee')

PAGE_W, PAGE_H = A4
MARGIN = 1.8 * cm

# ── 단락 스타일 ────────────────────────────────────────────────────────────
def S(name, **kw):
    defaults = dict(fontName='KR', fontSize=10, leading=16,
                    textColor=C_BLACK, spaceAfter=0, spaceBefore=0)
    defaults.update(kw)
    return ParagraphStyle(name, **defaults)

ST = {
    'h_title':   S('h_title',   fontSize=26, textColor=C_WHITE,   alignment=TA_CENTER, leading=34),
    'h_sub':     S('h_sub',     fontSize=11, textColor=colors.HexColor('#a0c8e8'), alignment=TA_CENTER, leading=18),
    'sec_num':   S('sec_num',   fontSize=13, textColor=C_WHITE,   leading=18),
    'sec_title': S('sec_title', fontSize=13, textColor=C_WHITE,   leading=18),
    'body':      S('body',      fontSize=10, textColor=C_BLACK,   leading=17, spaceAfter=3),
    'body_sm':   S('body_sm',   fontSize=9,  textColor=C_GRAY,    leading=15),
    'step':      S('step',      fontSize=10, textColor=C_BLUE,    leading=16, spaceBefore=6, spaceAfter=2),
    'code':      S('code',      fontName=MONO, fontSize=8.5, textColor=C_CODE_FG,
                   backColor=C_CODE_BG, leading=14,
                   leftIndent=10, rightIndent=10,
                   borderPadding=(5, 10, 5, 10)),
    'note':      S('note',      fontSize=9,  textColor=C_AMBER,   leading=14),
    'tbl_hdr':   S('tbl_hdr',   fontSize=9,  textColor=C_WHITE,   leading=14, alignment=TA_CENTER),
    'tbl_cmd':   S('tbl_cmd',   fontName=MONO, fontSize=8.5, textColor=C_CODE_FG,
                   backColor=C_CODE_BG, leading=13,
                   leftIndent=6, borderPadding=(3,6,3,6)),
    'tbl_body':  S('tbl_body',  fontSize=9,  textColor=C_BLACK,   leading=14),
    'footer':    S('footer',    fontSize=8,  textColor=C_GRAY,    alignment=TA_CENTER, leading=12),
}

# ── 커스텀 플로어블 ────────────────────────────────────────────────────────
class ColorRect(Flowable):
    """배경색 있는 박스 (섹션 헤더 등)"""
    def __init__(self, w, h, fill, radius=6):
        Flowable.__init__(self)
        self.w, self.h, self.fill, self.radius = w, h, fill, radius
    def wrap(self, *args): return self.w, self.h
    def draw(self):
        self.canv.setFillColor(self.fill)
        self.canv.roundRect(0, 0, self.w, self.h, self.radius, fill=1, stroke=0)


class SectionHeader(Flowable):
    """번호 + 제목 헤더 블록"""
    def __init__(self, num, title, color=C_NAVY, width=None):
        Flowable.__init__(self)
        self.num   = num
        self.title = title
        self.color = color
        self.width = width or (PAGE_W - 2 * MARGIN)
        self.height = 38

    def wrap(self, *args):
        return self.width, self.height

    def draw(self):
        c = self.canv
        w, h = self.width, self.height
        # Background
        c.setFillColor(self.color)
        c.roundRect(0, 0, w, h, 7, fill=1, stroke=0)
        # Number badge
        badge_w = 32
        c.setFillColor(colors.HexColor('#ffffff22'))
        c.roundRect(10, 7, badge_w, h - 14, 5, fill=1, stroke=0)
        # Number text
        c.setFillColor(C_WHITE)
        c.setFont('KR', 13)
        c.drawCentredString(10 + badge_w / 2, 12, self.num)
        # Title text
        c.setFont('KR', 13)
        c.drawString(52, 12, self.title)


class CodeBlock(Flowable):
    """다크 배경 코드 블록"""
    def __init__(self, lines, width=None):
        Flowable.__init__(self)
        self.lines = lines if isinstance(lines, list) else [lines]
        self.width = width or (PAGE_W - 2 * MARGIN)
        line_h = 16
        self.height = len(self.lines) * line_h + 18

    def wrap(self, *args):
        return self.width, self.height

    def draw(self):
        c = self.canv
        # Background
        c.setFillColor(C_CODE_BG)
        c.roundRect(0, 0, self.width, self.height, 5, fill=1, stroke=0)
        # Lines
        c.setFont(MONO, 9)
        y = self.height - 16
        for line in self.lines:
            if line.startswith('#'):
                c.setFillColor(colors.HexColor('#5a9a6a'))
            elif line.startswith('$') or line.startswith('>'):
                c.setFillColor(colors.HexColor('#ffd080'))
            elif line.startswith('  ') or line.startswith('\t'):
                c.setFillColor(colors.HexColor('#a0c8ff'))
            else:
                c.setFillColor(C_CODE_FG)
            c.drawString(12, y, line)
            y -= 16


class TipBox(Flowable):
    """팁/주의 박스"""
    def __init__(self, text, icon='💡', bg=C_AMBER_BG, border=None, width=None):
        Flowable.__init__(self)
        self.text   = text
        self.icon   = icon
        self.bg     = bg
        self.border = border or C_AMBER
        self.width  = width or (PAGE_W - 2 * MARGIN)
        self.height = 36

    def wrap(self, *args):
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(self.bg)
        c.roundRect(0, 0, self.width, self.height, 5, fill=1, stroke=0)
        c.setStrokeColor(self.border)
        c.setLineWidth(1.5)
        c.roundRect(0, 0, self.width, self.height, 5, fill=0, stroke=1)
        # Left accent bar
        c.setFillColor(self.border)
        c.roundRect(0, 0, 4, self.height, 3, fill=1, stroke=0)
        # Text
        c.setFillColor(colors.HexColor('#4a3010') if self.bg == C_AMBER_BG else C_BLACK)
        c.setFont('KR', 9)
        c.drawString(14, 13, f'{self.icon}  {self.text}')


# ── 헬퍼 ───────────────────────────────────────────────────────────────────
def sp(h=8):
    return Spacer(1, h)

def body(text):
    return Paragraph(text, ST['body'])

def step(num, text):
    return Paragraph(f'  {num}.  {text}', ST['step'])

def note(text):
    return Paragraph(f'※  {text}', ST['body_sm'])

def hr(color=C_LBLUE, thickness=1):
    return HRFlowable(width='100%', thickness=thickness, color=color, spaceAfter=6, spaceBefore=6)


# ── 페이지 이벤트 (헤더/푸터) ───────────────────────────────────────────────
def on_page(canvas, doc):
    canvas.saveState()
    # Top accent line
    canvas.setFillColor(C_BLUE)
    canvas.rect(0, PAGE_H - 6, PAGE_W, 6, fill=1, stroke=0)
    # Footer
    canvas.setFont('KR', 8)
    canvas.setFillColor(C_GRAY)
    canvas.drawCentredString(PAGE_W / 2, 18, f'GitHub Pages 배포 가이드  ·  {doc.page}')
    canvas.restoreState()


# ── 콘텐츠 조립 ────────────────────────────────────────────────────────────
def build_story(doc_width):
    W = doc_width
    story = []

    # ── 커버 헤더 ──────────────────────────────────────────────────────────
    cover = Table(
        [[Paragraph('GitHub Pages', ST['h_title'])],
         [Paragraph('배포 완전 정복 가이드', ST['h_title'])],
         [sp(4)],
         [Paragraph('Git 설정부터 자동 배포까지, 처음 배포하는 사람을 위한 단계별 안내서', ST['h_sub'])]],
        colWidths=[W]
    )
    cover.setStyle(TableStyle([
        ('BACKGROUND',  (0,0), (-1,-1), C_NAVY),
        ('ROUNDEDCORNERS', [10]),
        ('TOPPADDING',  (0,0), (-1,-1), 10),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ('LEFTPADDING',  (0,0), (-1,-1), 20),
        ('RIGHTPADDING', (0,0), (-1,-1), 20),
    ]))
    story.append(cover)
    story.append(sp(18))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 1 — Git 초기 설정
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('1', 'Git 초기 설정  (최초 1회)', C_NAVY, W))
    story.append(sp(8))
    story.append(body('Git을 처음 사용하거나 새 Mac에서 시작할 때 한 번만 실행하면 됩니다.'))
    story.append(sp(6))
    story.append(step('①', '사용자 이름 등록'))
    story.append(CodeBlock(['$ git config --global user.name "홍길동"'], W))
    story.append(sp(4))
    story.append(step('②', '이메일 등록  (GitHub 계정 이메일과 동일하게)'))
    story.append(CodeBlock(['$ git config --global user.email "you@example.com"'], W))
    story.append(sp(4))
    story.append(step('③', '기본 브랜치 이름을 main으로 설정'))
    story.append(CodeBlock(['$ git config --global init.defaultBranch main'], W))
    story.append(sp(6))
    story.append(TipBox('설정 확인:  git config --list', icon='✔', bg=C_GREEN_BG, border=C_GREEN, width=W))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 2 — GitHub 저장소 만들기
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('2', 'GitHub 저장소 만들기', C_BLUE, W))
    story.append(sp(8))

    steps2 = [
        ('①', 'github.com 접속 후 로그인'),
        ('②', '오른쪽 상단 "+" 클릭  →  New repository 선택'),
        ('③', 'Repository name 입력  (예: my-website)'),
        ('④', 'Public 선택  (Pages는 Public 저장소에서 무료)'),
        ('⑤', '"Create repository" 버튼 클릭'),
    ]
    for num, text in steps2:
        story.append(step(num, text))
        story.append(sp(2))

    story.append(sp(6))
    story.append(TipBox(
        '저장소 이름을 username.github.io 로 만들면 개인 도메인으로 자동 배포됩니다.',
        icon='💡', width=W
    ))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 3 — SSH 키 생성 및 등록
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('3', 'SSH 키 생성 및 등록  (최초 1회)', C_TEAL, W))
    story.append(sp(8))
    story.append(body('SSH 키를 사용하면 push/pull 시 매번 비밀번호를 입력할 필요가 없습니다.'))
    story.append(sp(6))
    story.append(step('①', 'SSH 키 생성'))
    story.append(CodeBlock([
        '$ ssh-keygen -t ed25519 -C "you@example.com"',
        '# Enter 3번 눌러 기본값으로 진행',
    ], W))
    story.append(sp(4))
    story.append(step('②', '공개 키 복사'))
    story.append(CodeBlock(['$ cat ~/.ssh/id_ed25519.pub | pbcopy'], W))
    story.append(sp(4))
    story.append(step('③', 'GitHub에 등록'))
    story.append(body('  GitHub → Settings → SSH and GPG keys → New SSH key'))
    story.append(body('  Title에 컴퓨터 이름 입력, Key에 복사한 내용 붙여넣기 → Add SSH key'))
    story.append(sp(4))
    story.append(step('④', '연결 테스트'))
    story.append(CodeBlock([
        '$ ssh -T git@github.com',
        '# Hi username! You have successfully authenticated ... 메시지 확인',
    ], W))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 4 — 프로젝트 파일 Push
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('4', '프로젝트 파일 Push하기', C_NAVY, W))
    story.append(sp(8))
    story.append(step('①', '프로젝트 폴더로 이동'))
    story.append(CodeBlock(['$ cd ~/my-website'], W))
    story.append(sp(4))
    story.append(step('②', 'Git 초기화  (새 프로젝트인 경우)'))
    story.append(CodeBlock(['$ git init'], W))
    story.append(sp(4))
    story.append(step('③', '원격 저장소 연결'))
    story.append(CodeBlock(['$ git remote add origin git@github.com:username/my-website.git'], W))
    story.append(sp(4))
    story.append(step('④', '파일 전체 스테이징'))
    story.append(CodeBlock(['$ git add .'], W))
    story.append(sp(4))
    story.append(step('⑤', '첫 커밋'))
    story.append(CodeBlock(['$ git commit -m "첫 번째 배포"'], W))
    story.append(sp(4))
    story.append(step('⑥', 'GitHub에 Push'))
    story.append(CodeBlock(['$ git push -u origin main'], W))
    story.append(sp(6))
    story.append(TipBox(
        'git remote -v 로 연결된 원격 저장소 주소를 확인할 수 있습니다.',
        icon='💡', width=W
    ))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 5 — GitHub Pages 활성화
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('5', 'GitHub Pages 활성화', C_BLUE, W))
    story.append(sp(8))

    steps5 = [
        ('①', '저장소 페이지 → Settings 탭 클릭'),
        ('②', '왼쪽 메뉴에서 Pages 선택'),
        ('③', 'Source: "Deploy from a branch" 선택'),
        ('④', 'Branch: main  /  폴더: / (root)  선택 후 Save'),
        ('⑤', '잠시 후 상단에 배포 URL이 표시됨'),
    ]
    for num, text in steps5:
        story.append(step(num, text))
        story.append(sp(2))

    story.append(sp(6))

    # URL 예시 박스
    url_table = Table(
        [[Paragraph('배포 완료 URL 예시', ST['body']),
          Paragraph('https://username.github.io/my-website', ST['code'])]],
        colWidths=[W * 0.35, W * 0.65]
    )
    url_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), C_LGRAY),
        ('ROUNDEDCORNERS', [6]),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ('LEFTPADDING', (0,0), (-1,-1), 12),
    ]))
    story.append(url_table)
    story.append(sp(6))
    story.append(TipBox(
        '배포까지 최대 2~3분 소요됩니다. Actions 탭에서 배포 진행 상황을 확인할 수 있습니다.',
        icon='⏱', width=W
    ))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 6 — 수정 후 업데이트
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('6', '수정 후 업데이트 방법', C_TEAL, W))
    story.append(sp(8))
    story.append(body('파일을 수정했다면 아래 3단계만 실행하면 자동으로 배포됩니다.'))
    story.append(sp(6))
    story.append(CodeBlock([
        '# 1. 변경된 파일 스테이징',
        '$ git add .',
        '',
        '# 2. 커밋 메시지 작성',
        '$ git commit -m "수정 내용 요약"',
        '',
        '# 3. GitHub에 Push  (이후로는 -u 없이 사용)',
        '$ git push',
    ], W))
    story.append(sp(6))

    # 특정 파일만 수정할 때
    story.append(body('특정 파일만 추가할 때:'))
    story.append(CodeBlock(['$ git add index.html style.css'], W))
    story.append(sp(6))
    story.append(TipBox(
        'Push 후 GitHub Actions 탭 → 최신 워크플로우 클릭으로 배포 상태를 실시간 확인 가능합니다.',
        icon='✔', bg=C_GREEN_BG, border=C_GREEN, width=W
    ))
    story.append(sp(16))

    # ═══════════════════════════════════════════════════════════════════════
    # 섹션 7 — 자주 쓰는 Git 명령어 표
    # ═══════════════════════════════════════════════════════════════════════
    story.append(SectionHeader('7', '자주 쓰는 Git 명령어 표', C_NAVY, W))
    story.append(sp(10))

    cmd_data = [
        # header
        [Paragraph('명령어', ST['tbl_hdr']),
         Paragraph('설명', ST['tbl_hdr']),
         Paragraph('예시', ST['tbl_hdr'])],
        # rows
        [Paragraph('git status', ST['tbl_cmd']),
         Paragraph('변경된 파일 목록 확인', ST['tbl_body']),
         Paragraph('git status', ST['tbl_cmd'])],

        [Paragraph('git add', ST['tbl_cmd']),
         Paragraph('파일을 스테이징 영역에 추가', ST['tbl_body']),
         Paragraph('git add .', ST['tbl_cmd'])],

        [Paragraph('git commit', ST['tbl_cmd']),
         Paragraph('변경 사항을 저장소에 기록', ST['tbl_body']),
         Paragraph('git commit -m "메시지"', ST['tbl_cmd'])],

        [Paragraph('git push', ST['tbl_cmd']),
         Paragraph('원격 저장소에 업로드', ST['tbl_body']),
         Paragraph('git push', ST['tbl_cmd'])],

        [Paragraph('git pull', ST['tbl_cmd']),
         Paragraph('원격 저장소에서 최신 내용 받기', ST['tbl_body']),
         Paragraph('git pull', ST['tbl_cmd'])],

        [Paragraph('git log', ST['tbl_cmd']),
         Paragraph('커밋 히스토리 확인', ST['tbl_body']),
         Paragraph('git log --oneline', ST['tbl_cmd'])],

        [Paragraph('git branch', ST['tbl_cmd']),
         Paragraph('브랜치 목록 확인 / 생성', ST['tbl_body']),
         Paragraph('git branch feature', ST['tbl_cmd'])],

        [Paragraph('git checkout', ST['tbl_cmd']),
         Paragraph('브랜치 전환 / 파일 복구', ST['tbl_body']),
         Paragraph('git checkout main', ST['tbl_cmd'])],

        [Paragraph('git merge', ST['tbl_cmd']),
         Paragraph('브랜치를 현재 브랜치에 병합', ST['tbl_body']),
         Paragraph('git merge feature', ST['tbl_cmd'])],

        [Paragraph('git stash', ST['tbl_cmd']),
         Paragraph('작업 중인 변경 사항 임시 저장', ST['tbl_body']),
         Paragraph('git stash / git stash pop', ST['tbl_cmd'])],

        [Paragraph('git clone', ST['tbl_cmd']),
         Paragraph('원격 저장소를 로컬에 복사', ST['tbl_body']),
         Paragraph('git clone <URL>', ST['tbl_cmd'])],

        [Paragraph('git remote -v', ST['tbl_cmd']),
         Paragraph('연결된 원격 저장소 주소 확인', ST['tbl_body']),
         Paragraph('git remote -v', ST['tbl_cmd'])],

        [Paragraph('git diff', ST['tbl_cmd']),
         Paragraph('수정된 내용 비교', ST['tbl_body']),
         Paragraph('git diff HEAD', ST['tbl_cmd'])],
    ]

    col_w = [W * 0.22, W * 0.38, W * 0.40]
    tbl = Table(cmd_data, colWidths=col_w, repeatRows=1)

    row_colors = []
    for i in range(1, len(cmd_data)):
        bg = C_LGRAY if i % 2 == 0 else C_WHITE
        row_colors.append(('BACKGROUND', (0, i), (-1, i), bg))

    tbl.setStyle(TableStyle([
        # Header
        ('BACKGROUND',   (0, 0), (-1, 0), C_NAVY),
        ('TEXTCOLOR',    (0, 0), (-1, 0), C_WHITE),
        ('TOPPADDING',   (0, 0), (-1, 0), 9),
        ('BOTTOMPADDING',(0, 0), (-1, 0), 9),
        # All cells
        ('FONTNAME',     (0, 0), (-1, -1), 'KR'),
        ('FONTSIZE',     (0, 0), (-1, -1), 9),
        ('VALIGN',       (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING',   (0, 1), (-1, -1), 7),
        ('BOTTOMPADDING',(0, 1), (-1, -1), 7),
        ('LEFTPADDING',  (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        # Grid
        ('LINEBELOW',    (0, 0), (-1, -2), 0.5, colors.HexColor('#dde4ec')),
        ('LINEBELOW',    (0, -1), (-1, -1), 1,   C_BLUE),
        ('LINEBEFORE',   (1, 0), (1, -1), 0.5,  colors.HexColor('#dde4ec')),
        ('LINEBEFORE',   (2, 0), (2, -1), 0.5,  colors.HexColor('#dde4ec')),
        ('ROUNDEDCORNERS', [6]),
    ] + row_colors))

    story.append(tbl)
    story.append(sp(14))

    # ── 마무리 박스 ────────────────────────────────────────────────────────
    final = Table(
        [[Paragraph('배포 흐름 요약', ST['body']),
          Paragraph(
              'git add .   →   git commit -m "메시지"   →   git push   →   자동 배포 완료',
              ST['code']
          )]],
        colWidths=[W * 0.25, W * 0.75]
    )
    final.setStyle(TableStyle([
        ('BACKGROUND',   (0,0), (-1,-1), C_NAVY),
        ('TEXTCOLOR',    (0,0), (0,-1),  C_WHITE),
        ('ROUNDEDCORNERS', [8]),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0), (-1,-1), 12),
        ('BOTTOMPADDING',(0,0), (-1,-1), 12),
        ('LEFTPADDING',  (0,0), (-1,-1), 14),
    ]))
    story.append(final)

    return story


# ── 메인 ───────────────────────────────────────────────────────────────────
OUTPUT = '/Users/nz/tennis-tournament/github_deploy_guide.pdf'

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    leftMargin=MARGIN,
    rightMargin=MARGIN,
    topMargin=MARGIN + 0.5 * cm,
    bottomMargin=MARGIN,
    title='GitHub Pages 배포 가이드',
    author='자미터 테니스 대회',
)

story = build_story(PAGE_W - 2 * MARGIN)
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f'PDF 생성 완료: {OUTPUT}')
