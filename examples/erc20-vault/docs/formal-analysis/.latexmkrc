# Builds with xelatex against the Sig.Network document template, a sibling
# checkout of github.com/sig-net/document-template unless
# SIG_DOCUMENT_TEMPLATE points elsewhere.
use Cwd 'abs_path';
use File::Basename 'dirname';
my $template = $ENV{SIG_DOCUMENT_TEMPLATE}
  // dirname(abs_path(__FILE__)) . '/../../../../../document-template';
$ENV{TEXINPUTS}     = "$template//:";
$ENV{OPENTYPEFONTS} = "$template/fonts//:";

$pdf_mode = 5;
$bibtex_use = 2;
$xelatex = 'xelatex -interaction=nonstopmode -synctex=1 %O %S';
