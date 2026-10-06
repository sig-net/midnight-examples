use Cwd 'abs_path';
use File::Basename 'dirname';
$ENV{OPENTYPEFONTS} = dirname(abs_path(__FILE__)) . '/fonts//:';

$pdf_mode = 5;
$bibtex_use = 2;
$xelatex = 'xelatex -interaction=nonstopmode -synctex=1 %O %S';
